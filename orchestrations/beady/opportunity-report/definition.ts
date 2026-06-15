import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import type { Env } from "@/runtime";
import { sendEmail } from "../../../integrations/resend/send";

// ─── Schemas ──────────────────────────────────────────────────────────────────

// Cron-driven: no caller input. The daily meta-cron fires this; each subscription's
// own cadence (daily/weekly) decides whether it is actually due this run.
export const inputSchema = z.object({});

export const outputSchema = z.object({
  subscriptionsDue: z.number(),
  emailsSent: z.number(),
  emailsSkipped: z.number(),
});

// ─── Types ──────────────────────────────────────────────────────────────────

interface Subscription {
  id: string;
  label: string | null;
  cadence: "daily" | "weekly";
  recipients: string[];
  min_fit_score: number;
  last_sent_at: string | null;
}

interface Opportunity {
  title: string;
  agency: string | null;
  set_aside: string | null;
  response_deadline: string | null;
  source: string | null;
  source_url: string | null;
  fit_score: number;
  fit_reason: string | null;
  recommendation: string | null;
  last_scored_at: string | null;
}

// ─── Supabase REST helpers (service role; runtime is trusted) ──────────────────

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

// report_subscriptions lives in the `orchestration` schema → PostgREST needs the
// Accept-Profile / Content-Profile headers to reach it.
async function loadActiveSubscriptions(env: Env): Promise<Subscription[]> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/report_subscriptions?is_active=eq.true&select=id,label,cadence,recipients,min_fit_score,last_sent_at`,
    { headers: sbHeaders(env, { "Accept-Profile": "orchestration" }) },
  );
  if (!res.ok) throw new Error(`load subscriptions → ${res.status}: ${await res.text()}`);
  return (await res.json()) as Subscription[];
}

async function markSent(env: Env, id: string, sentAt: string): Promise<void> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/report_subscriptions?id=eq.${id}`,
    {
      method: "PATCH",
      headers: sbHeaders(env, { "Content-Profile": "orchestration", Prefer: "return=minimal" }),
      body: JSON.stringify({ last_sent_at: sentAt, updated_at: sentAt }),
    },
  );
  if (!res.ok) throw new Error(`mark sent ${id} → ${res.status}: ${await res.text()}`);
}

// New pursue-rated opportunities scored since the subscription last fired.
async function loadNewPursueOpps(env: Env, sub: Subscription): Promise<Opportunity[]> {
  const params = new URLSearchParams({
    select: "title,agency,set_aside,response_deadline,source,source_url,fit_score,fit_reason,recommendation,last_scored_at",
    recommendation: "eq.pursue",
    fit_score: `gte.${sub.min_fit_score}`,
    order: "fit_score.desc,last_scored_at.desc",
    limit: "50",
  });
  // Only items scored since this subscription was last emailed (first run → all current).
  if (sub.last_sent_at) params.append("last_scored_at", `gt.${sub.last_sent_at}`);

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/opportunities?${params.toString()}`, {
    headers: sbHeaders(env),
  });
  if (!res.ok) throw new Error(`load opportunities → ${res.status}: ${await res.text()}`);
  return (await res.json()) as Opportunity[];
}

// ─── Cadence ──────────────────────────────────────────────────────────────────

// Daily subs are always due. Weekly subs are due if never sent or last sent ≳6.5
// days ago (slack so a daily cron that drifts by a few minutes still fires weekly
// on the 7th day rather than skipping to day 8).
function isDue(sub: Subscription, now: number): boolean {
  if (sub.cadence === "daily") return true;
  if (!sub.last_sent_at) return true;
  const elapsedDays = (now - new Date(sub.last_sent_at).getTime()) / 86_400_000;
  return elapsedDays >= 6.5;
}

// ─── HTML rendering ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDeadline(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return escapeHtml(iso);
  return d.toISOString().slice(0, 10);
}

function sourceLabel(source: string | null): string {
  if (source === "sam_gov") return "SAM.gov";
  if (source === "sbir") return "SBIR/STTR";
  return escapeHtml(source ?? "—");
}

function renderEmail(sub: Subscription, opps: Opportunity[]): { subject: string; html: string } {
  const subject = `Beady: ${opps.length} new pursue-rated ${opps.length === 1 ? "opportunity" : "opportunities"}`;

  const rows = opps
    .map((o) => {
      const titleCell = o.source_url
        ? `<a href="${escapeHtml(o.source_url)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(o.title)}</a>`
        : escapeHtml(o.title);
      return `
        <tr style="border-bottom:1px solid #e5e7eb;">
          <td style="padding:12px 8px;vertical-align:top;font-weight:600;color:#111827;">${titleCell}
            <div style="font-weight:400;color:#6b7280;font-size:13px;margin-top:4px;">${escapeHtml(o.fit_reason ?? "")}</div>
          </td>
          <td style="padding:12px 8px;vertical-align:top;color:#374151;white-space:nowrap;">${escapeHtml(o.agency ?? "—")}</td>
          <td style="padding:12px 8px;vertical-align:top;text-align:center;">
            <span style="display:inline-block;background:#dcfce7;color:#166534;border-radius:9999px;padding:2px 10px;font-weight:700;">${o.fit_score}</span>
          </td>
          <td style="padding:12px 8px;vertical-align:top;color:#374151;white-space:nowrap;">${fmtDeadline(o.response_deadline)}</td>
          <td style="padding:12px 8px;vertical-align:top;color:#6b7280;white-space:nowrap;">${sourceLabel(o.source)}</td>
        </tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html>
<body style="margin:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:720px;margin:0 auto;padding:24px;">
    <h1 style="font-size:20px;color:#111827;margin:0 0 4px;">New pursue-rated opportunities</h1>
    <p style="color:#6b7280;margin:0 0 20px;font-size:14px;">
      ${escapeHtml(sub.label ?? "Opportunity report")} · ${sub.cadence} · fit ≥ ${sub.min_fit_score}
    </p>
    <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#f3f4f6;text-align:left;">
          <th style="padding:10px 8px;font-size:12px;color:#6b7280;text-transform:uppercase;">Opportunity</th>
          <th style="padding:10px 8px;font-size:12px;color:#6b7280;text-transform:uppercase;">Agency</th>
          <th style="padding:10px 8px;font-size:12px;color:#6b7280;text-transform:uppercase;text-align:center;">Fit</th>
          <th style="padding:10px 8px;font-size:12px;color:#6b7280;text-transform:uppercase;">Deadline</th>
          <th style="padding:10px 8px;font-size:12px;color:#6b7280;text-transform:uppercase;">Source</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#9ca3af;font-size:12px;margin-top:20px;">
      Sent by Beady · manage this report from the LumiAgents dashboard → Reports.
    </p>
  </div>
</body>
</html>`;

  return { subject, html };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "beady/opportunity-report",
  version: 1,
  description:
    "Email the latest pursue-rated opportunities to report subscribers. Driven by a daily meta-cron; each subscription's cadence (daily/weekly) and min fit score are honored.",
  cron: "0 13 * * *",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx): Promise<z.infer<typeof outputSchema>> {
    const subscriptions = await step(ctx, "load-subscriptions", async () => {
      const all = await loadActiveSubscriptions(ctx.env);
      const now = Date.now();
      return all.filter((s) => Array.isArray(s.recipients) && s.recipients.length > 0 && isDue(s, now));
    });

    let emailsSent = 0;
    let emailsSkipped = 0;

    // One checkpointed step per subscription: query → render → send → stamp.
    // A subscription with no new pursue-rated items is stamped (so weekly cadence
    // advances) but no empty email is sent.
    for (const sub of subscriptions) {
      const outcome = await step(ctx, `report-${sub.id}`, async () => {
        const sentAt = new Date().toISOString();
        const opps = await loadNewPursueOpps(ctx.env, sub);

        if (opps.length === 0) {
          await markSent(ctx.env, sub.id, sentAt);
          return { sent: false as const, reason: "no-new-opportunities" };
        }

        const { subject, html } = renderEmail(sub, opps);
        const result = await sendEmail(ctx.env, { to: sub.recipients, subject, html });

        // Only advance last_sent_at on a real send — a failed/disabled send is
        // retried next run rather than silently dropping these opportunities.
        if (result.sent) {
          await markSent(ctx.env, sub.id, sentAt);
          return { sent: true as const, count: opps.length };
        }
        return { sent: false as const, reason: result.error ?? "send-failed" };
      });

      if (outcome.sent) emailsSent++;
      else emailsSkipped++;
    }

    return {
      subscriptionsDue: subscriptions.length,
      emailsSent,
      emailsSkipped,
    };
  },
});
