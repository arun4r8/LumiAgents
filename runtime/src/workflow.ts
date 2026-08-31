/**
 * Cloudflare Workflows entry point for durable orchestration execution.
 *
 * The HTTP worker creates a run row and dispatches to this Workflow, then returns
 * 202 immediately. The Workflow picks up the run_id, reconstructs the context
 * (including the workflowStep binding), and drives the orchestration to completion.
 *
 * Benefits over synchronous Worker execution:
 *   - Each step.do() is checkpointed, so crashes auto-resume from last completed step.
 *   - No 30s CPU limit per invocation (each step.do() resets the limit).
 *   - await_approval uses step.sleep() instead of PauseSignal, so no replay is needed.
 *   - LLM calls get automatic retries via step.do() retry config.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env, RunContext } from "./types";
import { SupabaseClient } from "./db/client";
import { orchestrations } from "./registry";
import type { KnowledgeScope } from "./agents/knowledge-access";
import { failRun, notifyRunSuccess } from "./utils/run-failure-alert";
import { resolveOrchestrationModel } from "./utils/resolve-model";

export interface RunWorkflowParams {
  runId: string;
  orchestrationName: string;
  /** Caller's knowledge scope (#177), when the run was started by an agent. Narrowing
   *  only; absent for a direct run, where the orchestration's own scope applies. */
  knowledgeScope?: KnowledgeScope;
}

export class RunOrchestration extends WorkflowEntrypoint<Env, RunWorkflowParams> {
  override async run(
    event: WorkflowEvent<RunWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { runId, orchestrationName, knowledgeScope } = event.payload;

    const db = new SupabaseClient(this.env);

    const orch = orchestrations.get(orchestrationName);
    if (!orch) {
      // Mark failed immediately; no run_step row to update
      const message = `Orchestration "${orchestrationName}" not registered`;
      await failRun(db, this.env, { runId, orchestrationName, message });
      throw new Error(message);
    }

    // Fetch the run to get the persisted input (avoids re-passing large payloads
    // through the Workflow params, which have a size limit).
    const run = await db.getRun(runId);

    const inputParsed = orch.inputSchema.safeParse(run.input);
    if (!inputParsed.success) {
      const message = "Stored run input failed schema validation";
      await failRun(db, this.env, { runId, orchestrationName, message });
      throw new Error(message);
    }

    const resolvedModel = await resolveOrchestrationModel(db, orchestrationName);

    let stepCounter = 0;

    const ctx: RunContext = {
      runId,
      stepIndex: () => stepCounter++,
      env: this.env,
      idempotencyKey: (tool, ...parts) => `${runId}:${tool}:${parts.join(":")}`,
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      workflowStep: step,
      model: resolvedModel,
      ...(knowledgeScope ? { knowledgeScope } : {}),
    };

    try {
      const output = await orch.run(ctx, inputParsed.data);
      // `updateRunUnlessCancelled`, not `updateRun`: POST /api/runs/:id/cancel marks
      // the run cancelled and then asks Workflows to terminate this instance. When
      // termination succeeds we never get here at all. When it does NOT (the binding
      // is unavailable, or the instance had already moved past the point where it can
      // be terminated), the instance runs on to this line — and an unconditional write
      // would flip `cancelled` back to `completed`, silently undoing a cancel the
      // operator was told had been recorded. A cancelled run stays cancelled.
      const settled = await db.updateRunUnlessCancelled(runId, {
        status: "completed",
        output,
        ended_at: new Date().toISOString(),
      });
      if (!settled) {
        console.log(`[workflow] run ${runId} finished after being cancelled; leaving it cancelled`);
      }
    } catch (err) {
      await failRun(db, this.env, {
        runId,
        orchestrationName,
        message: err instanceof Error ? err.message : String(err),
      });
      // Re-throw so Cloudflare marks the Workflow instance as failed.
      throw err;
    }

    // Only reached on success (the catch above always re-throws). Kept outside the
    // try so a hypothetical throw in here could never be mistaken for a run failure.
    await notifyRunSuccess(this.env, orchestrationName);
  }
}
