import type { Env, RunStatus } from "../types";
import type { RunForAction } from "../db/client";
import { SupabaseClient } from "../db/client";
import { orchestrations } from "../registry";
import { attributionFor } from "./orchestrations";
import { json, requireOpsToken, requireUser, rateLimited } from "./helpers";
import type { AuthPrincipal } from "./helpers";

// The only prefixes this route will ever accept. `list_recent_runs`'s tool schema
// (agent-chat.ts) never exposes a prefix/agent field to Claude — the caller always
// derives it from the authenticated agentSlug — but this route re-validates anyway,
// as defense in depth against a caller bug or a future caller that isn't as careful.
const KNOWN_AGENT_PREFIXES = new Set([
  "angie/", "beady/", "cleo/", "dewey/", "patch/", "money/",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Run actions: authorization ──────────────────────────────────────────────
//
// Two rules, applied to POST /api/runs/:id/rerun and POST /api/runs/:id/cancel.
// Both are pure functions over the row + the principal, so the rule is stated once
// and can be unit-tested without a database.

/**
 * Can this principal SEE this run?
 *
 * ops sees everything (`ops_all` on orchestration.runs). For anyone else this
 * mirrors, in code, the `enduser_read_own_or_approval` policy as it stands after
 * migration 20260724000002:
 *
 *   triggered_by_user_id = auth.uid()
 *   OR EXISTS (an approval on this run requested_from_user_id = auth.uid())
 *
 * It is a deliberate DUPLICATE of the policy rather than a delegation to it. This
 * route reads through the service role (like the whole runtime), so PostgREST would
 * happily hand back a row the caller cannot see. The alternative — re-reading the
 * run over PostgREST with the caller's own JWT — relies on the API gateway
 * preferring `Authorization` over `apikey`; if that assumption were ever wrong the
 * failure mode is a silent service-role read, i.e. privilege escalation. A
 * duplicated predicate fails the other way: a policy narrowed here but not there is
 * a bug a test can catch, not a bypass nobody can see. The drift risk is real and
 * is called out in the PR.
 *
 * The approvals policy's `requested_from_role` arm is deliberately NOT honoured:
 * that grants a whole ROLE sight of an approval, and using it to authorize stopping
 * or re-dispatching work would be a wider grant than the run policy itself makes.
 */
export function canSeeRun(
  run: Pick<RunForAction, "triggeredByUserId" | "approverUserIds">,
  auth: Pick<AuthPrincipal, "userId" | "role">,
): boolean {
  if (auth.role === "ops") return true;
  if (run.triggeredByUserId && run.triggeredByUserId === auth.userId) return true;
  return run.approverUserIds.includes(auth.userId);
}

/**
 * Can this principal RE-DISPATCH this run?
 *
 * Re-running starts real work, so it must not become a cheaper way in than
 * triggering the orchestration directly. Today's entitlement to trigger is: any
 * authenticated user may run any orchestration they can see, and an enduser can see
 * ACTIVE orchestrations only (`enduser_read_active`, relaxed to drop the
 * per-orchestration grant in 20260803000001). So on top of `canSeeRun`, a non-ops
 * caller additionally needs the run's orchestration to still exist and still be
 * active. ops may re-run anything, including a deactivated orchestration.
 */
export function canRerunRun(
  run: Pick<RunForAction, "triggeredByUserId" | "approverUserIds" | "orchestration">,
  auth: Pick<AuthPrincipal, "userId" | "role">,
): boolean {
  if (!canSeeRun(run, auth)) return false;
  if (auth.role === "ops") return true;
  return run.orchestration?.is_active === true;
}

// ─── Run actions: the cancel state machine ───────────────────────────────────

/** The statuses a run can be cancelled FROM. Everything else is already settled. */
export const CANCELLABLE: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "pending", "running", "paused",
]);

export function isCancellable(status: RunStatus): boolean {
  return CANCELLABLE.has(status);
}

// ─── Run actions: stopping the durable instance ──────────────────────────────

export type TerminationResult =
  | { terminated: true }
  | { terminated: false; reason: string };

/**
 * Ask Cloudflare Workflows to terminate the instance backing this run.
 *
 * Every dispatch path creates its instance with `id: run.id` (routes/orchestrations
 * .ts, routes/vault.ts and worker.ts's cron), so the run id IS the instance id and
 * no extra bookkeeping column is needed.
 *
 * What this does and does not guarantee is the entire point of the endpoint, so it
 * is stated plainly here and echoed to the caller:
 *
 *   • On success the instance is terminated: steps that had not started will not
 *     start, and the Workflow's own completion/failure writes never happen.
 *   • It does NOT unwind side effects. Anything the currently-executing step had
 *     already sent — an email, a Jira transition, a row a tool wrote — has happened
 *     and stays happened, and work already in flight inside that step may still
 *     land after termination is requested.
 *   • Not every run has an instance. A run started on the synchronous inline path
 *     (`/run-sync`) executes in-process with no Workflow at all, so `get()` fails
 *     and there is nothing to stop; the run is still marked cancelled and the
 *     caller is told termination did not happen.
 */
export async function terminateRunInstance(env: Env, runId: string): Promise<TerminationResult> {
  const wf = env.ORCHESTRATION_WORKFLOW;
  if (!wf || typeof wf.get !== "function") {
    return { terminated: false, reason: "the Workflows binding is not available in this environment" };
  }
  try {
    const instance = await wf.get(runId);
    await instance.terminate();
    return { terminated: true };
  } catch (err) {
    // `terminate()` throws when the instance is already complete/errored/terminated,
    // and `get()` throws when there is no instance at all (inline runs). Neither is
    // an error for us — both mean "there is nothing left to stop" — but the reason is
    // surfaced rather than swallowed, so the UI never claims more than happened.
    return { terminated: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Route ───────────────────────────────────────────────────────────────────

export async function handleRuns(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname, searchParams } = url;

  // GET /api/runs?prefix=<slug>/&sinceHours=&limit=
  if (pathname === "/api/runs" && request.method === "GET") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const rl = await rateLimited(env, authResult.userId, "runs-list", 30);
    if (rl) return rl;

    const prefix = searchParams.get("prefix") ?? "";
    if (!KNOWN_AGENT_PREFIXES.has(prefix)) {
      return json({ error: `Unknown or missing prefix "${prefix}"` }, 400);
    }

    const sinceHours = Math.min(Math.max(Number(searchParams.get("sinceHours") ?? 24), 1), 24 * 30);
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 10), 1), 50);
    const sinceISO = new Date(Date.now() - sinceHours * 3_600_000).toISOString();

    const db = new SupabaseClient(env);
    const runs = await db.listRecentRuns({ prefix, sinceISO, limit });
    return json({ runs });
  }

  // POST /api/runs/:id/rerun
  const rerunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/rerun$/);
  if (rerunMatch && request.method === "POST") {
    return rerun(request, env, decodeURIComponent(rerunMatch[1] ?? ""));
  }

  // POST /api/runs/:id/cancel
  const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (cancelMatch && request.method === "POST") {
    return cancel(request, env, decodeURIComponent(cancelMatch[1] ?? ""));
  }

  return null;
}

/**
 * Authenticate, rate-limit and resolve the run — the common prefix of both actions.
 *
 * A run the caller may not see is answered 404, never 403: "this run exists but is
 * not yours" is itself something an enduser should not be able to harvest.
 */
async function loadForAction(
  request: Request,
  env: Env,
  runId: string,
  bucket: string,
): Promise<{ error: Response } | { auth: AuthPrincipal; db: SupabaseClient; run: RunForAction }> {
  // Both actions are open to any authenticated user; what a given caller may do
  // with a given run is decided by canSeeRun/canRerunRun below.
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return { error: auth };

  const rl = await rateLimited(env, auth.userId, bucket, 30);
  if (rl) return { error: rl };

  // Guard before the query: a non-uuid makes PostgREST raise 22P02 rather than
  // simply returning no rows.
  if (!UUID_RE.test(runId)) return { error: json({ error: "Run not found" }, 404) };

  const db = new SupabaseClient(env);
  const run = await db.getRunForAction(runId);
  if (!run) return { error: json({ error: "Run not found" }, 404) };

  return { auth, db, run };
}

/**
 * POST /api/runs/:id/rerun — re-dispatch the same orchestration with the same
 * input, as a NEW run. The original run is never touched.
 */
async function rerun(request: Request, env: Env, runId: string): Promise<Response> {
  const loaded = await loadForAction(request, env, runId, "run-rerun");
  if ("error" in loaded) return loaded.error;
  const { auth, db, run } = loaded;

  if (!canSeeRun(run, auth)) return json({ error: "Run not found" }, 404);
  if (!canRerunRun(run, auth)) {
    return json({ error: "You cannot re-run this run: its orchestration is no longer active." }, 403);
  }

  const name = run.orchestration?.name;
  if (!name) {
    return json({ error: "This run's orchestration record no longer exists, so it cannot be re-run." }, 409);
  }

  // The registry is the *current* code. An orchestration that has since been removed
  // cannot be re-dispatched at all, whatever the run row remembers.
  const orch = orchestrations.get(name);
  if (!orch) {
    return json({ error: `Orchestration "${name}" is no longer registered, so this run cannot be re-run.` }, 409);
  }

  // Re-validate the STORED input against the CURRENT inputSchema. The schema may
  // have gained a required field or tightened a constraint since the original run,
  // in which case re-dispatching would hand the orchestration a payload it cannot
  // handle and produce a second failure that reads like a runtime bug. Refuse
  // instead, and say exactly which fields are wrong.
  const parsed = orch.inputSchema.safeParse(run.input);
  if (!parsed.success) {
    return json({
      error:
        `This run's saved input no longer satisfies the current input schema for "${name}" ` +
        `(v${orch.version}), so it was not re-dispatched. Start a new run from the ` +
        `orchestration form instead.`,
      issues: parsed.error.issues,
    }, 422);
  }

  // Dispatch against the version the code is on now, not the version the original
  // run used — that is what "re-run this" means once an orchestration has moved on,
  // and it resolves the same row /api/orchestrations/:name/run would have.
  //
  // Guarded, because `getOrchestrationByName` throws a bare Error when no row
  // matches and that would surface as a 500 with a raw internal message. It is a
  // REACHABLE state, not a theoretical one: orchestration rows are registered by SQL
  // migration, so a deploy that bumps a definition's `version` can legitimately land
  // before the registration migration applies. worker.ts's cron already guards the
  // identical call for the identical reason; re-run inherits that here, and says
  // plainly that this is a deployment-state problem rather than the caller's fault.
  let orchRecord: Awaited<ReturnType<typeof db.getOrchestrationByName>>;
  try {
    orchRecord = await db.getOrchestrationByName(name, orch.version);
  } catch {
    return json({
      error:
        `Orchestration "${name}" is registered in code at v${orch.version} but has no ` +
        `matching row in the orchestrations table, so this run cannot be re-run until ` +
        `its registration migration has been applied.`,
    }, 409);
  }

  const created = await db.createRerun({
    orchestration_id: orchRecord.id,
    orchestration_version: orch.version,
    status: "running",
    input: parsed.data,
    // Attributed to the CALLER, not to whoever started the original run: they are
    // the person dispatching this work, and triggered_by_user_id is what the enduser
    // RLS policy reads, so this is also what makes the new run visible to them.
    ...attributionFor(auth),
    rerun_of: run.id,
    started_at: new Date().toISOString(),
  });

  await env.ORCHESTRATION_WORKFLOW.create({
    id: created.id,
    params: { runId: created.id, orchestrationName: name },
  });

  return json({
    runId: created.id,
    rerunOf: run.id,
    orchestration: name,
    version: orch.version,
    status: "running",
  }, 202);
}

/**
 * POST /api/runs/:id/cancel — mark the run cancelled and stop its Workflow
 * instance. See `terminateRunInstance` for what "stop" does and does not mean.
 */
async function cancel(request: Request, env: Env, runId: string): Promise<Response> {
  const loaded = await loadForAction(request, env, runId, "run-cancel");
  if ("error" in loaded) return loaded.error;
  const { auth, db, run } = loaded;

  // Cancelling needs only visibility of the run, not the orchestration entitlement
  // re-running needs: stopping work is not dispatching work, and the two kinds of
  // person a run is visible to — whoever triggered it, and whoever is being asked to
  // approve it — are exactly the people entitled to stop it.
  if (!canSeeRun(run, auth)) return json({ error: "Run not found" }, 404);

  if (!isCancellable(run.status)) {
    return json({ error: `Run is ${run.status} and cannot be cancelled.`, status: run.status }, 409);
  }

  // The DB, not the check above, is the concurrency gate: the UPDATE only fires from
  // a live status, so a cancel that races the run's own completion loses cleanly.
  const cancelled = await db.cancelRunIfLive(run.id);
  if (!cancelled) {
    const now = await db.getRunForAction(run.id);
    return json({
      error: `Run is ${now?.status ?? "no longer cancellable"} and cannot be cancelled.`,
      status: now?.status ?? null,
    }, 409);
  }

  const termination = await terminateRunInstance(env, run.id);

  // Only worth doing once the run really is cancelled: closes out the step left
  // mid-flight so the timeline does not pulse underneath a settled run.
  await db.skipRunningSteps(run.id);

  return json({
    runId: run.id,
    status: "cancelled",
    terminated: termination.terminated,
    effect: termination.terminated ? "terminated" : "marked-only",
    message: termination.terminated
      ? "Run cancelled and its workflow instance terminated. Steps that had not started " +
        "will not run. Anything the step that was executing had already sent cannot be recalled."
      : `Run marked cancelled, but its workflow instance could not be terminated ` +
        `(${termination.reason}). If it is still executing it will keep going until it ` +
        `finishes; the run stays marked cancelled either way.`,
  }, 200);
}
