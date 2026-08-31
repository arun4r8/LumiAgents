import { z } from "zod";
import type { Env, OrchestrationDefinition, Run, TriggerSource } from "../types";
import { orchestrations } from "../registry";
import { SupabaseClient } from "../db/client";
import { runOrchestrationInline } from "../run-inline";
import { json, schemaToJsonSchema, requireUser, requireOpsToken, rateLimited } from "./helpers";
import type { AuthPrincipal } from "./helpers";
import type { KnowledgeScope } from "../agents/knowledge-access";
import { scopeForAgent, scopeForConfigAgent } from "../agents/knowledge-access";

type AnyOrch = OrchestrationDefinition<z.ZodTypeAny, z.ZodTypeAny>;

/**
 * Decide who a run is attributed to (#127). Pure, so the decision is unit-testable.
 *
 * The enduser RLS policy on orchestration.runs is `triggered_by_user_id = auth.uid()`,
 * so a run with a NULL triggered_by_user_id is invisible to the person who caused it.
 * Agent chat dispatches with the internal `agent-dispatch` principal, which is not a
 * real user — but its token carries `act_for`, the id of the signed-in end user whose
 * message triggered the dispatch. That claim is attribution only: it never widens
 * authorization (the principal stays agent-dispatch / role "ops"), it only decides what
 * gets written into the run row.
 *
 * `triggered_by` stays inside the existing orchestration.trigger_source enum so every
 * current reader (dashboard run list, run detail, stats) keeps rendering: "user" when a
 * human is behind the run (directly or via act_for), "webhook" for a genuine machine call.
 */
export function attributionFor(
  auth: Pick<AuthPrincipal, "userId" | "actFor">,
): { triggered_by: TriggerSource; triggered_by_user_id?: string } {
  const realUserId = auth.userId === "agent-dispatch" ? undefined : auth.userId;
  const attributedTo = auth.actFor ?? realUserId;
  return attributedTo
    ? { triggered_by: "user", triggered_by_user_id: attributedTo }
    : { triggered_by: "webhook" };
}

// Shared by /run and /run-sync: look up the orchestration, validate the body against
// its inputSchema, and persist the run row (status:"running"). Both routes trigger
// execution differently from this point on (fire-and-forget Workflow vs. awaited inline).
async function parseAndCreateRun(
  request: Request,
  env: Env,
  name: string,
  auth: Pick<AuthPrincipal, "userId" | "actFor">,
): Promise<{ error: Response } | { orch: AnyOrch; db: SupabaseClient; run: Run; input: unknown }> {
  const orch = orchestrations.get(name);
  if (!orch) return { error: json({ error: `Orchestration "${name}" not found` }, 404) };

  let body: unknown;
  try { body = await request.json(); }
  catch { return { error: json({ error: "Invalid JSON body" }, 400) }; }

  const parsed = orch.inputSchema.safeParse(body);
  if (!parsed.success) {
    return { error: json({ error: "Invalid input", issues: parsed.error.issues }, 422) };
  }

  const db = new SupabaseClient(env);
  const orchRecord = await db.getOrchestrationByName(name, orch.version);
  const run = await db.createRun({
    orchestration_id: orchRecord.id,
    orchestration_version: orch.version,
    status: "running",
    input: parsed.data,
    ...attributionFor(auth),
    started_at: new Date().toISOString(),
  });

  return { orch, db, run, input: parsed.data };
}

/**
 * The knowledge scope a run should retrieve under, derived from the CALLER (#177).
 *
 * `auth.agentSlug` comes from the `agent_slug` claim the runtime itself mints onto a
 * dispatch token — never from the request body or a header, so a caller cannot choose
 * its own scope.
 *
 *   · config agent (has a catalog row) → its declared corpora, intersected with
 *     [shared, <ownSlug>, enduser]. This is the #177 fix: a config agent that wires
 *     `dewey/knowledge-search` no longer inherits dewey's private corpus.
 *   · code agent (no catalog row)      → scopeForAgent(slug). Each of the six wires only
 *     its own retrieval orchestration, so caller and donor slug coincide and this is
 *     identical to the pre-#177 behaviour.
 *   · no slug / lookup failure         → undefined, leaving the orchestration's own scope
 *     in place. Retrieval must not start failing because the catalog is briefly
 *     unreachable; the fallback is the previous behaviour, never a wider one.
 */
async function callerKnowledgeScope(
  db: SupabaseClient,
  auth: Pick<AuthPrincipal, "agentSlug">,
): Promise<KnowledgeScope | undefined> {
  const slug = auth.agentSlug;
  if (!slug) return undefined;
  try {
    const row = await db.getCatalogAgent(slug);
    return row
      ? scopeForConfigAgent(slug, row.knowledge_corpora)
      : scopeForAgent(slug);
  } catch {
    return undefined;
  }
}

export async function handleOrchestrations(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;

  // POST /api/orchestrations/:name/run
  const runMatch = pathname.match(/^\/api\/orchestrations\/([^/]+)\/run$/);
  if (runMatch && request.method === "POST") {
    // Orchestration runs are open to any authenticated user (ops + enduser).
    const authResult = await requireUser(request, env);
    if (authResult instanceof Response) return authResult;

    const rl = await rateLimited(env, authResult.userId, "orchestration-run", 30);
    if (rl) return rl;

    const name = decodeURIComponent(runMatch[1] ?? "");
    const created = await parseAndCreateRun(request, env, name, authResult);
    if ("error" in created) return created.error;
    const { run, db } = created;

    await env.ORCHESTRATION_WORKFLOW.create({
      id: run.id,
      // knowledgeScope travels in params so the durable path clamps retrieval the same
      // way the inline path does (#177). Serializable by construction.
      params: {
        runId: run.id,
        orchestrationName: name,
        knowledgeScope: await callerKnowledgeScope(db, authResult),
      },
    });

    return json({ runId: run.id, status: "running" }, 202);
  }

  // POST /api/orchestrations/:name/run-sync
  // Awaits real execution in-process (no Workflow) and returns the actual output.
  //
  // Two gates (#127), because the inline path has no durable execution and retries a
  // failed step up to 4x in-process (primitives/step.ts):
  //   1. OPS ONLY. requireOpsToken still accepts the internally-minted agent-dispatch
  //      principal, so agents' sync tools keep working, but a signed-in enduser can no
  //      longer execute arbitrary orchestrations inline. Endusers trigger orchestrations
  //      through the durable /run path, which is intentionally left open to them.
  //   2. The orchestration must declare `readOnly: true`. This is the server-side
  //      enforcement of the rule that used to exist only as a comment and as an
  //      inferred-by-name set in agents/catalog-validation.ts.
  const runSyncMatch = pathname.match(/^\/api\/orchestrations\/([^/]+)\/run-sync$/);
  if (runSyncMatch && request.method === "POST") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const rl = await rateLimited(env, authResult.userId, "orchestration-run-sync", 30);
    if (rl) return rl;

    const name = decodeURIComponent(runSyncMatch[1] ?? "");

    // Check readOnly before creating a run row, so a refused call leaves no orphan run.
    const target = orchestrations.get(name);
    if (!target) return json({ error: `Orchestration "${name}" not found` }, 404);
    if (target.readOnly !== true) {
      return json({
        error: `Orchestration "${name}" is not declared readOnly and cannot be executed on ` +
          `the synchronous inline path (no durable execution, steps may retry). ` +
          `Use POST /api/orchestrations/${name}/run instead.`,
      }, 400);
    }

    const created = await parseAndCreateRun(request, env, name, authResult);
    if ("error" in created) return created.error;
    const { orch, db, run, input } = created;

    const knowledgeScope = await callerKnowledgeScope(db, authResult);
    const result = await runOrchestrationInline(env, db, orch, run.id, input, knowledgeScope);
    if (result.status === "failed") {
      return json({ runId: run.id, status: "failed", error: result.error }, 200);
    }
    if (result.status === "paused") {
      // Defence in depth: a readOnly orchestration must contain no await_approval, so
      // this should be unreachable. If it ever happens the run is correctly parked as
      // "paused" (not failed, no alert) and the caller is told to follow the run.
      return json({
        runId: run.id,
        status: "paused",
        approvalId: result.approvalId,
        output: {
          status: "paused",
          approvalId: result.approvalId,
          message: `Run ${run.id} is paused awaiting approval ${result.approvalId}.`,
        },
      }, 200);
    }
    return json({ runId: run.id, status: "completed", output: result.output }, 200);
  }

  // GET /api/orchestrations
  if (pathname === "/api/orchestrations" && request.method === "GET") {
    const catalogue = Array.from(orchestrations.values()).map((o) => ({
      name: o.name,
      version: o.version,
      description: o.description ?? null,
      access: o.access,
      triggerMode: o.triggerMode ?? "manual",
      // Explicit read-only declaration (#127): the only thing /run-sync and the config
      // agent validator may use to decide sync eligibility.
      readOnly: o.readOnly === true,
      inputSchema: schemaToJsonSchema(o.inputSchema),
    }));
    return json(catalogue);
  }

  return null;
}
