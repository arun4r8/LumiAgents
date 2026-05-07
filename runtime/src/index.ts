import { z } from "zod";
import type { Env, OrchestrationDefinition, RunContext, ToolDefinition } from "./types";
import { SupabaseClient } from "./db/client";
import { step } from "./primitives/step";
import { llm_decide, llm_extract } from "./primitives/llm";
import { await_approval } from "./primitives/approval";

export { step, llm_decide, llm_extract, await_approval };
export type { RunContext, OrchestrationDefinition, ToolDefinition, Env };

// ─── defineOrchestration ─────────────────────────────────────────────────────

export function defineOrchestration<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(def: OrchestrationDefinition<TInput, TOutput>): OrchestrationDefinition<TInput, TOutput> {
  return def;
}

// ─── defineTool ───────────────────────────────────────────────────────────────

export function defineTool<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(def: ToolDefinition<TInput, TOutput>): (ctx: RunContext, input: z.infer<TInput>) => Promise<z.infer<TOutput>> {
  return async (ctx, input) => {
    const db = new SupabaseClient(ctx.env);

    const toolCallRow = await db.createToolCall({
      run_step_id: ctx.runId, // caller sets the step id via ctx; simplified here
      tool_name: def.name,
      request: input,
    });

    const started = Date.now();
    try {
      const parsed = def.inputSchema.parse(input);
      const output = await def.run(ctx, parsed);
      def.outputSchema.parse(output); // validate output

      await db.updateToolCall(toolCallRow.id, {
        response: output,
        status: "success",
        latency_ms: Date.now() - started,
      });

      return output;
    } catch (err) {
      await db.updateToolCall(toolCallRow.id, {
        status: "failed",
        latency_ms: Date.now() - started,
      });
      throw err;
    }
  };
}

// ─── HTTP trigger handler ─────────────────────────────────────────────────────

type OrchestrationsMap = Map<string, OrchestrationDefinition<z.ZodTypeAny, z.ZodTypeAny>>;

export function createHandler(orchestrations: OrchestrationsMap) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);

      // POST /api/orchestrations/:name/run
      const match = url.pathname.match(/^\/api\/orchestrations\/([^/]+)\/run$/);
      if (!match || request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }

      const name = decodeURIComponent(match[1] ?? "");
      const orch = orchestrations.get(name);
      if (!orch) {
        return new Response(JSON.stringify({ error: `Orchestration "${name}" not found` }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const parsed = orch.inputSchema.safeParse(body);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: "Invalid input", issues: parsed.error.issues }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        });
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

      let stepCounter = 0;

      const ctx: RunContext = {
        runId: run.id,
        stepIndex: () => stepCounter++,
        env,
        idempotencyKey: (tool, ...parts) => `${run.id}:${tool}:${parts.join(":")}`,
        fetch: (...args) => fetch(...args),
      };

      try {
        const output = await orch.run(ctx, parsed.data);
        await db.updateRun(run.id, {
          status: "completed",
          output,
          ended_at: new Date().toISOString(),
        });
        return new Response(JSON.stringify({ runId: run.id, output }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        await db.updateRun(run.id, {
          status: "failed",
          error: { message: err instanceof Error ? err.message : String(err) },
          ended_at: new Date().toISOString(),
        });
        return new Response(
          JSON.stringify({ runId: run.id, error: err instanceof Error ? err.message : String(err) }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    },
  };
}
