import type { Env } from "./types";
import { orchestrations } from "./registry";
import { SupabaseClient } from "./db/client";
import { scheduleDue } from "./utils/cron-match";
import { drainN8nCallQueue } from "./utils/n8n-queue-drainer";
import { failRun } from "./utils/run-failure-alert";
import { handleOrchestrations } from "./routes/orchestrations";
import { handleDocuments } from "./routes/documents";
import { handleApprovals } from "./routes/approvals";
import { handleAgents } from "./routes/agents";
import { handleSchedules } from "./routes/schedules";
import { handleVault } from "./routes/vault";

// Re-export the WorkflowEntrypoint so Cloudflare can locate the class by name.
export { RunOrchestration } from "./workflow";

async function dispatchCron(_cronExpr: string, env: Env): Promise<void> {
  const db = new SupabaseClient(env);
  const now = new Date();

  let schedules: Awaited<ReturnType<typeof db.getActiveSchedules>>;
  try {
    schedules = await db.getActiveSchedules();
  } catch (err) {
    console.error("[cron] failed to load schedules from DB:", err);
    return;
  }

  for (const schedule of schedules) {
    const lastRunAt = schedule.last_run_at ? new Date(schedule.last_run_at) : null;
    if (!scheduleDue(schedule.cron_expression, now, lastRunAt)) continue;

    const orch = orchestrations.get(schedule.orchestration_name);
    if (!orch) {
      console.error(`[cron] schedule ${schedule.id}: orchestration "${schedule.orchestration_name}" not in registry`);
      continue;
    }

    const inputResult = orch.inputSchema.safeParse(schedule.default_input ?? {});
    if (!inputResult.success) {
      console.error(`[cron] ${orch.name}: default_input failed schema validation`, inputResult.error);
      continue;
    }

    let orchRecord: Awaited<ReturnType<typeof db.getOrchestrationByName>>;
    try {
      orchRecord = await db.getOrchestrationByName(orch.name, orch.version);
    } catch (err) {
      console.error(`[cron] ${orch.name}: not found in orchestrations table`, err);
      continue;
    }

    const run = await db.createRun({
      orchestration_id: orchRecord.id,
      orchestration_version: orch.version,
      status: "running",
      input: inputResult.data,
      triggered_by: "cron",
      started_at: now.toISOString(),
    });

    try {
      await env.ORCHESTRATION_WORKFLOW.create({
        id: run.id,
        params: { runId: run.id, orchestrationName: orch.name },
      });
      await db.touchSchedule(schedule.id, now.toISOString());
      console.log(`[cron] ${orch.name} dispatched (run ${run.id})`);
    } catch (err) {
      // Dispatch never reached the Workflow, so this is the only place that can
      // alert on it.
      await failRun(db, env, {
        runId: run.id,
        orchestrationName: orch.name,
        message: `Workflow dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      console.error(`[cron] ${orch.name} failed to dispatch (run ${run.id}):`, err);
    }
  }
}

// Resolve the CORS origin: reflect the request Origin if it's allowlisted,
// otherwise the primary allowed origin. Unset ALLOWED_ORIGINS preserves "*".
function corsOrigin(request: Request, env: Env): string {
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return "*";
  const origin = request.headers.get("Origin") ?? "";
  return origin && allowed.includes(origin) ? origin : (allowed[0] as string);
}

function withCors(res: Response, request: Request, env: Env): Response {
  const r = new Response(res.body, res);
  r.headers.set("Access-Control-Allow-Origin", corsOrigin(request, env));
  r.headers.set("Vary", "Origin");
  return r;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": corsOrigin(request, env),
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Vary": "Origin",
        },
      });
    }

    try {
      const handlers = [
        handleOrchestrations,
        handleDocuments,
        handleApprovals,
        handleAgents,
        handleSchedules,
        handleVault,
      ];

      for (const handler of handlers) {
        const res = await handler(request, env, ctx, url);
        if (res !== null) return withCors(res, request, env);
      }

      if (url.pathname === "/health") {
        return withCors(new Response(
          JSON.stringify({ status: "ok", environment: env.ENVIRONMENT, orchestrations: orchestrations.size }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ), request, env);
      }

      return withCors(new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }), request, env);
    } catch (err) {
      console.error("Worker error:", err);
      return withCors(new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ), request, env);
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await Promise.all([
      dispatchCron(controller.cron, env),
      drainN8nCallQueue(env),
    ]);
  },
} satisfies ExportedHandler<Env>;
