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
import { failRun, notifyRunSuccess } from "./utils/run-failure-alert";
import { MODELS } from "./config/models";

export interface RunWorkflowParams {
  runId: string;
  orchestrationName: string;
}

export class RunOrchestration extends WorkflowEntrypoint<Env, RunWorkflowParams> {
  override async run(
    event: WorkflowEvent<RunWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { runId, orchestrationName } = event.payload;

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

    // Resolve model: per-orchestration override → agent default → fallback
    const DEFAULT_MODEL: string = MODELS.sonnet;
    const agentId = orchestrationName.split("/")[0] ?? "";
    let resolvedModel = DEFAULT_MODEL;
    try {
      const [agentCfg, orchRow] = await Promise.all([
        db.getAgentConfig(agentId).catch(() => null),
        db.getOrchestrationByName(orchestrationName).catch(() => null),
      ]);
      resolvedModel = orchRow?.model ?? agentCfg?.model ?? DEFAULT_MODEL;
    } catch {
      // non-fatal; default is safe
    }

    let stepCounter = 0;

    const ctx: RunContext = {
      runId,
      stepIndex: () => stepCounter++,
      env: this.env,
      idempotencyKey: (tool, ...parts) => `${runId}:${tool}:${parts.join(":")}`,
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      workflowStep: step,
      model: resolvedModel,
    };

    try {
      const output = await orch.run(ctx, inputParsed.data);
      await db.updateRun(runId, {
        status: "completed",
        output,
        ended_at: new Date().toISOString(),
      });
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
