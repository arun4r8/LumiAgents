import type { Env } from "./types";
import { orchestrations } from "./registry";
import { SupabaseClient } from "./db/client";
import { scheduleDue } from "./utils/cron-match";
import { handleOrchestrations } from "./routes/orchestrations";
import { handleDocuments } from "./routes/documents";
import { handleApprovals } from "./routes/approvals";
import { handleAgents } from "./routes/agents";
import { handleSchedules } from "./routes/schedules";

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
      await db.updateRun(run.id, {
        status: "failed",
        error: { message: err instanceof Error ? err.message : String(err) },
        ended_at: now.toISOString(),
      });
      console.error(`[cron] ${orch.name} failed to dispatch (run ${run.id}):`, err);
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
      ];

      for (const handler of handlers) {
        const res = await handler(request, env, ctx, url);
        if (res !== null) return res;
      }

      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({ status: "ok", environment: env.ENVIRONMENT, orchestrations: orchestrations.size }),
          { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
        );
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    } catch (err) {
      console.error("Worker error:", err);
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
        { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
      );
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await dispatchCron(controller.cron, env);
  },
} satisfies ExportedHandler<Env>;
