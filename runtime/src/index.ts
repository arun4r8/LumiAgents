import { z } from "zod";
import type { Env, OrchestrationDefinition, RunContext, ToolDefinition } from "./types";
import { SupabaseClient } from "./db/client";
import { step } from "./primitives/step";
import { llm_decide, llm_extract } from "./primitives/llm";
import { await_approval } from "./primitives/approval";
import { PauseSignal } from "./primitives/pause";

export { step, llm_decide, llm_extract, await_approval, PauseSignal };
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
      run_step_id: ctx.runId,
      tool_name: def.name,
      request: input,
    });

    const started = Date.now();
    try {
      const parsed = def.inputSchema.parse(input);
      const output = await def.run(ctx, parsed);
      def.outputSchema.parse(output);

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
