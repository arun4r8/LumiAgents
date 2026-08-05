import { createClient } from "@/lib/supabase/server";
import { roleOf } from "@/lib/role";
import {
  isTerminal,
  queuedFromPlan,
  snapshotFor,
  type RawRun,
  type RawStep,
  type RunSnapshot,
} from "@/lib/run-view";

/**
 * Load the run snapshot that the embedded run card and the run-detail timeline
 * both render.
 *
 * RLS, deliberately: this goes through `lib/supabase/server`, i.e. the *user's*
 * cookie session and the anon key — never `lib/supabase/admin` (service role).
 * That is what makes the run card correct for an enduser as well as for ops:
 *
 *   • orchestration.runs      — enduser sees rows where `triggered_by_user_id =
 *     auth.uid()` (the attribution fixed in #127/#131 via the `act_for` claim) or
 *     where they are the approver. A run they did not start is simply not there,
 *     and the card renders its "not available" state rather than an error.
 *   • orchestration.run_steps — enduser sees steps of runs visible by that rule.
 *   • orchestration.orchestrations — enduser sees ACTIVE orchestrations only, so
 *     the joined name can legitimately come back null for a run of a deactivated
 *     orchestration. Every caller therefore treats the name as optional and the
 *     chat path passes the name it already has (from the chat response) as the
 *     fallback. Nothing about the card requires an ops-only read.
 *
 * `isOps` gates raw error text only, and it is applied server-side in
 * `snapshotFor` — a non-ops caller never receives `errorDetail` at all.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OrchJoin = { name: string; version: number } | { name: string; version: number }[] | null;

function oneOrch(value: OrchJoin): { name: string; version: number } | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

const STEP_COLUMNS =
  "id, step_index, step_name, step_type, status, started_at, ended_at, output, error";

/**
 * The step plan for an in-flight run: the step names of the most recent COMPLETED
 * run of the same orchestration.
 *
 * `orchestration.step_status` has no 'queued' value and a step row is only written
 * once the step starts, so without this the card could never draw the queued state
 * the design specifies, and "step N of total" would always read "N of N". The plan
 * is a hint, not a contract: it is read under the same RLS as everything else (an
 * enduser who has never run this orchestration before simply gets no plan), and
 * `queuedFromPlan` drops any planned name the live run has already produced, so a
 * run that diverges from the plan just shows fewer queued rows.
 */
async function loadStepPlan(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orchestrationId: string | null,
  excludeRunId: string,
): Promise<string[]> {
  if (!orchestrationId) return [];

  const { data: reference } = await supabase
    .schema("orchestration")
    .from("runs")
    .select("id")
    .eq("orchestration_id", orchestrationId)
    .eq("status", "completed")
    .neq("id", excludeRunId)
    .order("ended_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const referenceId = (reference as { id: string } | null)?.id;
  if (!referenceId) return [];

  const { data: planSteps } = await supabase
    .schema("orchestration")
    .from("run_steps")
    .select("step_name, step_index")
    .eq("run_id", referenceId)
    .order("step_index");

  return ((planSteps ?? []) as { step_name: string }[]).map((s) => s.step_name);
}

/** Returns null when the run is not visible to the caller (or does not exist). */
export async function loadRunSnapshot(id: string): Promise<RunSnapshot | null> {
  // Guard before the query: a non-uuid would make PostgREST raise 22P02 rather
  // than simply return nothing.
  if (!UUID_RE.test(id)) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const isOps = roleOf(user) === "ops";

  const { data: run } = await supabase
    .schema("orchestration")
    .from("runs")
    .select(
      "id, status, triggered_by, created_at, started_at, ended_at, error, orchestration_id, orchestrations(name, version)",
    )
    .eq("id", id)
    .maybeSingle();

  if (!run) return null;

  const row = run as unknown as {
    id: string;
    status: string;
    triggered_by: string | null;
    created_at: string;
    started_at: string | null;
    ended_at: string | null;
    error: unknown;
    orchestration_id: string | null;
    orchestrations: OrchJoin;
  };

  const { data: steps } = await supabase
    .schema("orchestration")
    .from("run_steps")
    .select(STEP_COLUMNS)
    .eq("run_id", id)
    .order("step_index");

  const stepRows = (steps ?? []) as unknown as RawStep[];

  // A settled run has no future: skip the two extra plan queries entirely.
  const plan = isTerminal(row.status)
    ? []
    : await loadStepPlan(supabase, row.orchestration_id, id);
  const queued = queuedFromPlan(plan, stepRows.map((s) => s.step_name));

  const orch = oneOrch(row.orchestrations);
  const rawRun: RawRun = {
    id: row.id,
    status: row.status,
    triggered_by: row.triggered_by,
    created_at: row.created_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
    error: row.error,
    orchestration: orch?.name ?? null,
    version: orch?.version ?? null,
  };

  return snapshotFor(rawRun, stepRows, queued, isOps);
}
