/**
 * Synchronous, in-process orchestration execution — no Cloudflare Workflow instance.
 *
 * Omitting `workflowStep` from the RunContext puts step() into its non-Workflow retry
 * branch (plain in-process backoff instead of wf.do() checkpointing) — see
 * primitives/step.ts. This lets `dispatchTool` await a real answer instead of getting
 * back a bare runId, for tools whose whole purpose is answering a question.
 *
 * Only correct for orchestrations that are fast and read-only: unlike the Workflow
 * path, there's no 30s-CPU-limit escape hatch here, and a step retried on transient
 * failure could re-run more than once — harmless for a read, unsafe for a mutation.
 * Callers (routes/orchestrations.ts's /run-sync) must only reach this for tools
 * explicitly marked `mode: "sync"` in a ToolMapping.
 */

import type { Env, OrchestrationDefinition, RunContext } from "./types";
import { z } from "zod";
import { SupabaseClient } from "./db/client";
import { failRun, notifyRunSuccess } from "./utils/run-failure-alert";
import { resolveOrchestrationModel } from "./utils/resolve-model";

type AnyOrch = OrchestrationDefinition<z.ZodTypeAny, z.ZodTypeAny>;

export type InlineRunResult =
  | { status: "completed"; output: unknown }
  | { status: "failed"; error: string };

export async function runOrchestrationInline(
  env: Env,
  db: SupabaseClient,
  orch: AnyOrch,
  runId: string,
  input: unknown,
): Promise<InlineRunResult> {
  const model = await resolveOrchestrationModel(db, orch.name);
  let stepCounter = 0;

  const ctx: RunContext = {
    runId,
    stepIndex: () => stepCounter++,
    env,
    idempotencyKey: (tool, ...parts) => `${runId}:${tool}:${parts.join(":")}`,
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    model,
    // workflowStep intentionally omitted.
  };

  try {
    const output = await orch.run(ctx, input);
    await db.updateRun(runId, {
      status: "completed",
      output,
      ended_at: new Date().toISOString(),
    });
    await notifyRunSuccess(env, orch.name);
    return { status: "completed", output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // failRun already writes status:"failed" + error to the run row, and handles
    // ops alerting the same way every Workflow-driven failure does.
    await failRun(db, env, { runId, orchestrationName: orch.name, message });
    return { status: "failed", error: message };
  }
}
