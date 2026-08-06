import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import OverviewClient, {
  type FleetAgent,
  type StreamEvent,
  type ThroughputBucket,
} from "@/components/overview-client";
import FirstRunNote from "@/components/first-run-note";
import { roleOf } from "@/lib/role";
import { cardFromRow } from "@/lib/agent-catalog";
import { agentOfOrchestration, bareOrchestration } from "@/lib/agent-style";
import { costUsd } from "@/lib/llm-pricing";
import { fmtUsd, type SpendRow } from "@/lib/spend";

export const dynamic = "force-dynamic";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface RunRow {
  id: string;
  status: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  orchestrations: { name: string } | null;
}

interface StepRow {
  id: string;
  run_id: string;
  step_name: string;
  status: string;
  started_at: string | null;
  runs: { orchestrations: { name: string } | null } | null;
}

/**
 * Overview — the fleet at a glance.
 *
 * Ops only. The redesign IA is explicit that an enduser has no Overview
 * ("Enduser role sees: Overview? No"), and phase 2 gated it out of the nav; this
 * closes the direct-URL hole too. It is not merely a cosmetic gate: under RLS an
 * enduser reads only their OWN runs, so the fleet would render six agents all
 * reading "idle" and a throughput chart of nothing while the fleet was in fact
 * busy — a dashboard that is quietly, confidently wrong. Sending them to /agents
 * (their landing page, per app/page.tsx) is the honest answer.
 */
export default async function OverviewPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (roleOf(user) !== "ops") redirect("/agents");

  // M13 (#71): the ops first-run line, shown once. `onboarded_at` lives in
  // user_metadata so it follows the account, not the browser.
  const showFirstRun = !user?.user_metadata?.onboarded_at;

  // Reading the clock is the whole point of a `force-dynamic` dashboard: the
  // week/day windows and the "12m ago" labels are relative to request time, and
  // this is an async Server Component that runs once per request, not a render
  // that can be replayed. The purity lint rule can't see that distinction.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const dayAgo = new Date(now - DAY).toISOString();

  const [
    agentRowsRes,
    weekTotalRes,
    weekCleanRes,
    weekSettledRes,
    pendingRes,
    dayRunsRes,
    openRunsRes,
    stepsRes,
    spendRes,
  ] = await Promise.all([
    // The catalog is read with the service-role client for the same reason the
    // /agents list does: orchestration.agents is ops-only under RLS and a
    // cross-worker fetch would need a session token in a server render.
    createAdminClient()
      .schema("orchestration").from("agents")
      .select("slug, display_name, card, source, lifecycle")
      .eq("lifecycle", "active")
      .order("display_name"),

    supabase.schema("orchestration").from("runs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", weekAgo),

    supabase.schema("orchestration").from("runs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", weekAgo)
      .eq("status", "completed"),

    supabase.schema("orchestration").from("runs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", weekAgo)
      .in("status", ["completed", "failed", "cancelled", "paused"]),

    supabase.schema("orchestration").from("approvals")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),

    // 24h of runs drives the throughput chart and the "nothing failed" line.
    supabase.schema("orchestration").from("runs")
      .select("id, status, created_at, started_at, ended_at, orchestrations(name)")
      .gte("created_at", dayAgo)
      .order("created_at", { ascending: false })
      .limit(500),

    // A long-running or paused run can predate the 24h window, so the fleet's
    // live state comes from its own query rather than a slice of the chart data.
    supabase.schema("orchestration").from("runs")
      .select("id, status, created_at, started_at, ended_at, orchestrations(name)")
      .in("status", ["running", "paused"])
      .order("created_at", { ascending: false })
      .limit(100),

    supabase.schema("orchestration").from("run_steps")
      .select("id, run_id, step_name, status, started_at, runs(orchestrations(name))")
      .order("started_at", { ascending: false })
      .limit(14),

    // agent_spend is SECURITY DEFINER + is_ops-gated; ops sees rows, and a
    // failure returns no data rather than throwing.
    supabase.rpc("agent_spend", { p_days: 7 }),
  ]);

  const agents = (agentRowsRes.data ?? []).map((r) =>
    cardFromRow(r as Parameters<typeof cardFromRow>[0]),
  );

  const dayRuns = (dayRunsRes.data ?? []) as unknown as RunRow[];
  const openRuns = (openRunsRes.data ?? []) as unknown as RunRow[];
  const steps = (stepsRes.data ?? []) as unknown as StepRow[];

  // ── fleet ──────────────────────────────────────────────────────────────
  // Orchestrations are named `<agent>/<job>`, so a run maps to its agent by
  // prefix (see lib/agent-style.ts).
  const runningIds = openRuns.filter((r) => r.status === "running").map((r) => r.id);
  const { data: openStepRows } = runningIds.length
    ? await supabase.schema("orchestration").from("run_steps")
        .select("run_id, status")
        .in("run_id", runningIds)
    : { data: [] as { run_id: string; status: string }[] };
  const openSteps = (openStepRows ?? []) as { run_id: string; status: string }[];

  function stepProgress(runId: string): string | null {
    const rows = openSteps.filter((s) => s.run_id === runId);
    if (rows.length === 0) return null;
    const done = rows.filter((s) => s.status === "completed").length;
    return `step ${Math.min(done + 1, rows.length)}/${rows.length}`;
  }

  const lastFinishedByAgent = new Map<string, RunRow>();
  for (const r of dayRuns) {
    const slug = agentOfOrchestration(r.orchestrations?.name);
    if (!slug || lastFinishedByAgent.has(slug)) continue;
    lastFinishedByAgent.set(slug, r);
  }

  const fleet: FleetAgent[] = agents.map((a) => {
    const mine = openRuns.filter((r) => agentOfOrchestration(r.orchestrations?.name) === a.slug);
    const running = mine.find((r) => r.status === "running");
    const paused = mine.find((r) => r.status === "paused");

    if (running) {
      const job = bareOrchestration(running.orchestrations?.name) || "a run";
      const progress = stepProgress(running.id);
      return {
        slug: a.slug,
        name: a.name,
        domain: a.category,
        state: "running",
        sub: progress ? `${job} · ${progress}` : `${job} · starting`,
      };
    }
    if (paused) {
      return {
        slug: a.slug,
        name: a.name,
        domain: a.category,
        state: "blocked",
        sub: `${bareOrchestration(paused.orchestrations?.name) || "a run"} · waiting on you`,
      };
    }
    const last = lastFinishedByAgent.get(a.slug);
    return {
      slug: a.slug,
      name: a.name,
      domain: a.category,
      state: "idle",
      sub: last
        ? `${bareOrchestration(last.orchestrations?.name)} ${last.status} · ${sinceLabel(last.ended_at ?? last.created_at, now)}`
        : "nothing in the last 24h",
    };
  });

  // ── throughput: 24 hourly buckets, oldest first ────────────────────────
  const buckets: ThroughputBucket[] = Array.from({ length: 24 }, () => ({ runs: 0, failed: 0 }));
  for (const r of dayRuns) {
    const age = now - new Date(r.created_at).getTime();
    const hoursAgo = Math.floor(age / HOUR);
    if (hoursAgo < 0 || hoursAgo >= 24) continue;
    const bucket = buckets[23 - hoursAgo]!;
    bucket.runs++;
    if (r.status === "failed") bucket.failed++;
  }
  const failed24 = dayRuns.filter((r) => r.status === "failed").length;

  // ── recent activity ────────────────────────────────────────────────────
  const stream: StreamEvent[] = steps.map((s) => {
    const orch = s.runs?.orchestrations?.name ?? null;
    return {
      id: s.id,
      at: s.started_at,
      agent: agentOfOrchestration(orch),
      status: s.status,
      message: messageFor(s.status, s.step_name, bareOrchestration(orch)),
    };
  });

  // ── stats ──────────────────────────────────────────────────────────────
  const weekRuns = weekTotalRes.count ?? 0;
  const settled = weekSettledRes.count ?? 0;
  const clean = weekCleanRes.count ?? 0;
  const pending = pendingRes.count ?? 0;

  const spendRows = (spendRes.data ?? []) as SpendRow[];
  const spend = spendRows.reduce(
    (sum, r) => sum + costUsd(r.model, r.input_tokens, r.output_tokens),
    0,
  );

  const working = fleet.filter((f) => f.state === "running").length;

  return (
    <>
      {showFirstRun && (
        <FirstRunNote
          variant="line"
          body="This is the whole fleet: every agent, what is running right now, what is waiting on a human, and what it is costing. Scheduled sweeps fire on their own, so these numbers move without anyone touching them. Anything that needs you shows up in Approvals with a count in the nav."
        />
      )}
      <OverviewClient
        working={working}
        pending={pending}
        failed24={failed24}
        weekRuns={weekRuns}
        cleanPct={settled > 0 ? (100 * clean) / settled : null}
        spendLabel={spendRows.length > 0 ? fmtUsd(spend) : "—"}
        fleet={fleet}
        buckets={buckets}
        stream={stream}
      />
    </>
  );
}

// ─── copy helpers ─────────────────────────────────────────────────────────────

/** "12m ago" / "3h ago" — the fleet tile's mono status line. */
function sinceLabel(iso: string | null, now: number): string {
  if (!iso) return "just now";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** One plain sentence per activity row — never a bare status word. */
function messageFor(status: string, step: string, job: string): string {
  const where = job ? ` on ${job}` : "";
  switch (status) {
    case "completed": return `finished ${step}${where}`;
    case "running":   return `running ${step}${where}`;
    case "failed":    return `${step} failed${where}`;
    case "skipped":   return `skipped ${step}${where}`;
    default:          return `${step} — ${status}${where}`;
  }
}
