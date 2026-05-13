import type { Env } from "../types";
import { orchestrations } from "../registry";
import { SupabaseClient } from "../db/client";
import { json, schemaToJsonSchema } from "./helpers";

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
    const name = decodeURIComponent(runMatch[1] ?? "");
    const orch = orchestrations.get(name);
    if (!orch) return json({ error: `Orchestration "${name}" not found` }, 404);

    let body: unknown;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON body" }, 400); }

    const parsed = orch.inputSchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Invalid input", issues: parsed.error.issues }, 422);
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

    await env.ORCHESTRATION_WORKFLOW.create({
      id: run.id,
      params: { runId: run.id, orchestrationName: name },
    });

    return json({ runId: run.id, status: "running" }, 202);
  }

  // GET /api/orchestrations
  if (pathname === "/api/orchestrations" && request.method === "GET") {
    const catalogue = Array.from(orchestrations.values()).map((o) => ({
      name: o.name,
      version: o.version,
      description: o.description ?? null,
      access: o.access,
      inputSchema: schemaToJsonSchema(o.inputSchema),
    }));
    return json(catalogue);
  }

  return null;
}
