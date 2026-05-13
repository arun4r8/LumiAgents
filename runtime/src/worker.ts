import type { Env } from "./types";
import { orchestrations } from "./registry";
import { SupabaseClient } from "./db/client";
import { handleOrchestrations } from "./routes/orchestrations";
import { handleDocuments } from "./routes/documents";
import { handleApprovals } from "./routes/approvals";
import { handleAgents } from "./routes/agents";
import { handleVault } from "./routes/vault";

// Re-export the WorkflowEntrypoint so Cloudflare can locate the class by name.
export { RunOrchestration } from "./workflow";

async function dispatchCron(cronExpr: string, env: Env): Promise<void> {
  const matching = Array.from(orchestrations.values()).filter((o) => o.cron === cronExpr);

  for (const orch of matching) {
    const inputResult = orch.inputSchema.safeParse({});
    if (!inputResult.success) {
      console.error(`[cron] ${orch.name}: default input failed validation`, inputResult.error);
      continue;
    }

    const db = new SupabaseClient(env);
    let orchRecord: Awaited<ReturnType<typeof db.getOrchestrationByName>>;
    try {
      orchRecord = await db.getOrchestrationByName(orch.name, orch.version);
    } catch (err) {
      console.error(`[cron] ${orch.name}: orchestration record not found in DB`, err);
      continue;
    }

    const run = await db.createRun({
      orchestration_id: orchRecord.id,
      orchestration_version: orch.version,
      status: "running",
      input: inputResult.data,
      triggered_by: "cron",
      started_at: new Date().toISOString(),
    });

    try {
      await env.ORCHESTRATION_WORKFLOW.create({
        id: run.id,
        params: { runId: run.id, orchestrationName: orch.name },
      });
      console.log(`[cron] ${orch.name} dispatched to Workflow (run ${run.id})`);
    } catch (err) {
      await db.updateRun(run.id, {
        status: "failed",
        error: { message: err instanceof Error ? err.message : String(err) },
        ended_at: new Date().toISOString(),
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
        handleVault,
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
