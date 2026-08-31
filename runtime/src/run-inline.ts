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
 * That rule is now enforced, not merely documented: /run-sync is ops-only and refuses
 * any orchestration that does not declare `readOnly: true` (#127).
 */

import type { Env, OrchestrationDefinition, RunContext } from "./types";
import type { KnowledgeScope } from "./agents/knowledge-access";
import { z } from "zod";
import { SupabaseClient } from "./db/client";
import { PauseSignal } from "./primitives/pause";
import { failRun, notifyRunSuccess } from "./utils/run-failure-alert";
import { resolveOrchestrationModel } from "./utils/resolve-model";

type AnyOrch = OrchestrationDefinition<z.ZodTypeAny, z.ZodTypeAny>;

export type InlineRunResult =
  | { status: "completed"; output: unknown }
  | { status: "paused"; approvalId: string }
  | { status: "failed"; error: string };

/**
 * `await_approval` signals "not finished, waiting on a human" by throwing PauseSignal —
 * it is deliberately NOT a failure. The `instanceof` check is the primary test; the
 * structural fallback keeps this correct if the class is ever duplicated across bundles
 * (each agent Worker bundles its own copy of the runtime).
 */
function isPauseSignal(err: unknown): err is PauseSignal {
  if (err instanceof PauseSignal) return true;
  return (
    err instanceof Error &&
    err.name === "PauseSignal" &&
    typeof (err as { approvalId?: unknown }).approvalId === "string"
  );
}

export async function runOrchestrationInline(
  env: Env,
  db: SupabaseClient,
  orch: AnyOrch,
  runId: string,
  input: unknown,
  /** Caller's read scope (#177). Undefined for a direct run, where the orchestration's
   *  own scope applies. Narrowing only — see routes/orchestrations.ts. */
  knowledgeScope?: KnowledgeScope,
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
    ...(knowledgeScope ? { knowledgeScope } : {}),
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
    // A pause is not a failure (#127). Previously this fell into failRun, which marked
    // the run "failed", fired an ops alert, and orphaned the pending approval row that
    // await_approval had just created. Park the run as "paused" instead — the same
    // status the Workflow path writes while it waits on a decision (primitives/
    // approval.ts) — and leave the approval to be decided and the run replayed.
    if (isPauseSignal(err)) {
      await db.updateRun(runId, { status: "paused" });
      return { status: "paused", approvalId: err.approvalId };
    }

    const message = err instanceof Error ? err.message : String(err);
    // failRun already writes status:"failed" + error to the run row, and handles
    // ops alerting the same way every Workflow-driven failure does.
    await failRun(db, env, { runId, orchestrationName: orch.name, message });
    return { status: "failed", error: message };
  }
}
