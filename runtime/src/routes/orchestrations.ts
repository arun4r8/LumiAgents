import { z } from "zod";
import type { Env, OrchestrationDefinition, Run } from "../types";
import { orchestrations } from "../registry";
import { SupabaseClient } from "../db/client";
import { runOrchestrationInline } from "../run-inline";
import { json, schemaToJsonSchema, requireUser, rateLimited } from "./helpers";

type AnyOrch = OrchestrationDefinition<z.ZodTypeAny, z.ZodTypeAny>;

// Shared by /run and /run-sync: look up the orchestration, validate the body against
// its inputSchema, and persist the run row (status:"running"). Both routes trigger
// execution differently from this point on (fire-and-forget Workflow vs. awaited inline).
async function parseAndCreateRun(
  request: Request,
  env: Env,
  name: string,
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
    triggered_by: "webhook",
    started_at: new Date().toISOString(),
  });

  return { orch, db, run, input: parsed.data };
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
    const created = await parseAndCreateRun(request, env, name);
    if ("error" in created) return created.error;
    const { run } = created;

    await env.ORCHESTRATION_WORKFLOW.create({
      id: run.id,
      params: { runId: run.id, orchestrationName: name },
    });

    return json({ runId: run.id, status: "running" }, 202);
  }

  // POST /api/orchestrations/:name/run-sync
  // Awaits real execution in-process (no Workflow) and returns the actual output.
  // Reserve for orchestrations backing tools marked `mode: "sync"` in a ToolMapping —
  // see run-inline.ts for why this is only safe for fast, read-only orchestrations.
  const runSyncMatch = pathname.match(/^\/api\/orchestrations\/([^/]+)\/run-sync$/);
  if (runSyncMatch && request.method === "POST") {
    const authResult = await requireUser(request, env);
    if (authResult instanceof Response) return authResult;

    const rl = await rateLimited(env, authResult.userId, "orchestration-run-sync", 30);
    if (rl) return rl;

    const name = decodeURIComponent(runSyncMatch[1] ?? "");
    const created = await parseAndCreateRun(request, env, name);
    if ("error" in created) return created.error;
    const { orch, db, run, input } = created;

    const result = await runOrchestrationInline(env, db, orch, run.id, input);
    if (result.status === "failed") {
      return json({ runId: run.id, status: "failed", error: result.error }, 200);
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
      inputSchema: schemaToJsonSchema(o.inputSchema),
    }));
    return json(catalogue);
  }

  return null;
}
