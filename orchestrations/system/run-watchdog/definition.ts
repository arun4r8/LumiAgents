import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";
import { sendAlertEmail, subscriptionRecipients } from "../../../integrations/resend/alert";
import { senderFor } from "../../../integrations/resend/sender";
import type { Env } from "@/runtime";

/**
 * The gap this fills, in one sentence: nothing was watching for a run that fails
 * WITHOUT failing.
 *
 * `run-failure-alert.ts` fires on `status = 'failed'`, and each sweep has its own
 * health alert. Between them they cover a lot, and they covered none of what
 * actually happened on 2026-09-07:
 *
 *  - A run killed by Cloudflare (subrequest ceiling) never gets to write its own
 *    failure, because the invocation writing it is the one that died. It stays
 *    `running` in the database for ever. Two did.
 *  - A run that completes with `samFound: 0` is green.
 *  - A schedule that stops firing is invisible: `last_run_at` is written but never
 *    read back in anger.
 *
 * Five sweeps failed across ~35 hours, the daily digest went out throughout
 * describing an unchanged table, and it was found by hand. Every check below is one
 * that would have caught it on the first occurrence.
 */

export const inputSchema = z.object({
  stuckAfterMinutes: z
    .number()
    .int()
    .min(5)
    .default(90)
    .describe("A run still 'running' after this long is presumed dead. The longest legitimate sweep is ~30 min."),
  overdueMultiplier: z
    .number()
    .min(1.5)
    .default(2.5)
    .describe("A schedule is overdue once this many of its own intervals have passed since last_run_at."),
  emptyRunLookback: z
    .number()
    .int()
    .min(1)
    .default(3)
    .describe("How many recent completed runs to compare against when judging a suspiciously empty one."),
});

const findingSchema = z.object({
  kind: z.enum(["stuck", "overdue", "empty"]),
  subject: z.string().describe("Orchestration or schedule the finding is about"),
  detail: z.string(),
});

export const outputSchema = z.object({
  findings: z.array(findingSchema),
  alerted: z.boolean(),
  recipients: z.number(),
  checked: z.object({ runs: z.number(), schedules: z.number() }),
});

type Finding = z.infer<typeof findingSchema>;

// ─── Checks ───────────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  status: string;
  started_at: string;
  output: Record<string, unknown> | null;
  orchestrations: { name: string } | null;
}

interface ScheduleRow {
  orchestration_name: string;
  cron_expression: string;
  is_active: boolean;
  last_run_at: string | null;
}

/**
 * Roughly how often a cron fires, in minutes. Deliberately crude: it only has to be
 * good enough to tell "hours late" from "on time", and a wrong answer here produces
 * a noisy alert rather than a missed one.
 */
export function cronIntervalMinutes(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, , dow] = parts;
  if (min === "*") return 1;
  if (hour === "*") return 60;
  if (dom !== "*" || dow !== "*") return 60 * 24 * 7; // weekly-ish
  return 60 * 24; // daily
}

/** A run still 'running' long past any legitimate duration is presumed dead. */
export function findStuckRuns(runs: RunRow[], now: Date, stuckAfterMinutes: number): Finding[] {
  const cutoff = now.getTime() - stuckAfterMinutes * 60_000;
  return runs
    .filter((r) => r.status === "running" && new Date(r.started_at).getTime() < cutoff)
    .map((r) => ({
      kind: "stuck" as const,
      subject: r.orchestrations?.name ?? r.id,
      detail:
        `run ${r.id} has been 'running' since ${r.started_at} (over ${stuckAfterMinutes} min). ` +
        `A run killed by the platform never writes its own failure, so this is what that looks like. ` +
        `Check with: wrangler workflows instances describe orchestration-workflow ${r.id}`,
    }));
}

/** A schedule that has not fired in several of its own intervals has stopped. */
export function findOverdueSchedules(
  schedules: ScheduleRow[],
  now: Date,
  multiplier: number,
): Finding[] {
  const out: Finding[] = [];
  for (const s of schedules) {
    if (!s.is_active) continue;
    const interval = cronIntervalMinutes(s.cron_expression);
    if (interval === null) continue;
    if (!s.last_run_at) {
      out.push({
        kind: "overdue",
        subject: s.orchestration_name,
        detail: `schedule '${s.cron_expression}' is active but has never run.`,
      });
      continue;
    }
    const lateBy = (now.getTime() - new Date(s.last_run_at).getTime()) / 60_000;
    if (lateBy > interval * multiplier) {
      out.push({
        kind: "overdue",
        subject: s.orchestration_name,
        detail:
          `schedule '${s.cron_expression}' last ran ${Math.round(lateBy / 60)}h ago, ` +
          `which is more than ${multiplier}x its ~${Math.round(interval / 60)}h interval.`,
      });
    }
  }
  return out;
}

/**
 * A completed run that produced NOTHING while its recent history produced something.
 *
 * The rule is deliberately "zero, not merely lower", and that is the whole design.
 * A proportional rule looks smarter and is worse: the sweep's healthy `samFound`
 * moved from ~8,500 to 161 the day its filters started working, an order-of-
 * magnitude drop that was the single most important CORRECT change of that week. A
 * 10x-drop rule alerts on it. A watchdog that fires on correct behaviour is one
 * people learn to ignore, and then it is worth less than nothing.
 *
 * Zero is unambiguous: no notices found, or none kept from notices that were found.
 * That is what every silent failure on 2026-09-07 looked like, and legitimate
 * fluctuation never looks like it.
 */
export function findEmptyRuns(runs: RunRow[], lookback: number): Finding[] {
  const byName = new Map<string, RunRow[]>();
  for (const r of runs) {
    if (r.status !== "completed" || !r.output) continue;
    const name = r.orchestrations?.name;
    if (!name) continue;
    byName.set(name, [...(byName.get(name) ?? []), r]);
  }

  const out: Finding[] = [];
  for (const [name, rows] of byName) {
    // rows arrive newest-first
    const [latest, ...rest] = rows;
    if (!latest) continue;
    const history = rest.slice(0, lookback);
    if (history.length === 0) continue;

    for (const key of ["samFound", "shortlistCount", "awardsFound"]) {
      const current = Number(latest.output?.[key]);
      const priors = history.map((h) => Number(h.output?.[key])).filter((n) => Number.isFinite(n) && n > 0);
      if (!Number.isFinite(current) || priors.length === 0) continue;
      if (current === 0) {
        const median = priors.sort((a, b) => a - b)[Math.floor(priors.length / 2)]!;
        out.push({
          kind: "empty",
          subject: name,
          detail:
            `latest run reports ${key}=0, against a recent median of ${median}. ` +
            `It completed, so nothing else will mention it.`,
        });
      }
    }
  }
  return out;
}

// ─── Orchestration ────────────────────────────────────────────────────────────

async function loadJson<T>(env: Env, path: string): Promise<T> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: sbHeaders(env, { profile: "orchestration" }),
  });
  if (!res.ok) throw new Error(`watchdog load ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export default defineOrchestration({
  name: "system/run-watchdog",
  version: 1,
  description:
    "Hourly check for runs that failed without failing: stuck 'running' rows the platform killed, schedules that stopped firing, and completed runs whose numbers collapsed.",
  cron: "20 * * * *",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const { findings, counts } = await step(ctx, "collect-findings", async () => {
      const now = new Date();

      // One request each. This orchestration must be cheap: it runs hourly and is
      // the thing that notices when other things are not cheap.
      const runs = await loadJson<RunRow[]>(
        ctx.env,
        "runs?select=id,status,started_at,output,orchestrations!inner(name)&order=started_at.desc&limit=200",
      );
      const schedules = await loadJson<ScheduleRow[]>(
        ctx.env,
        "schedules?select=orchestration_name,cron_expression,is_active,last_run_at",
      );

      return {
        findings: [
          ...findStuckRuns(runs, now, input.stuckAfterMinutes),
          ...findOverdueSchedules(schedules, now, input.overdueMultiplier),
          ...findEmptyRuns(runs, input.emptyRunLookback),
        ],
        counts: { runs: runs.length, schedules: schedules.length },
      };
    });

    if (findings.length === 0) {
      return { findings: [], alerted: false, recipients: 0, checked: counts };
    }

    const alert = await step(ctx, "alert", async () => {
      const lines = findings.map((f) => `- [${f.kind}] ${f.subject}: ${f.detail}`);
      const text =
        `LumiAgents watchdog found ${findings.length} thing(s) that would not have alerted on their own.\n\n` +
        `${lines.join("\n\n")}\n\n` +
        `Checked ${counts.runs} recent runs and ${counts.schedules} schedules.`;
      const to = await subscriptionRecipients(ctx.env);
      const result = await sendAlertEmail(ctx.env, {
        to,
        subject: `⚠️ LumiAgents watchdog: ${findings.length} silent failure(s)`,
        text,
        from: senderFor(ctx.env, "system"),
      });
      return { sent: result.sent, recipients: to.length };
    });

    return { findings, alerted: alert.sent, recipients: alert.recipients, checked: counts };
  },
});
