import type { RunContext } from "../types";
import { SupabaseClient } from "../db/client";
import { PauseSignal } from "./pause";

const RETRY_DELAYS_MS = [1000, 3000, 10000]; // used in non-Workflow mode only

export async function step<T>(
  ctx: RunContext,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const db = new SupabaseClient(ctx.env);
  const idx = ctx.stepIndex();

  // ── Cloudflare Workflows mode ─────────────────────────────────────────────
  // When running inside a Workflow, delegate durability and retry to the
  // platform. Each step.do() is checkpointed — if the Worker crashes, the
  // Workflow resumes from the last completed step automatically.
  if (ctx.workflowStep) {
    const wf = ctx.workflowStep;

    // Create the run_step row before execution (also durable via step.do)
    const runStepId = await wf.do(`step-${idx}-open`, async () => {
      const rs = await db.createRunStep({
        run_id: ctx.runId,
        step_index: idx,
        step_name: name,
        step_type: "step",
        status: "running",
      });
      return rs.id;
    });

    ctx.currentStepId = runStepId;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const output = (await wf.do(`step-${idx}-run`, {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
      }, fn as () => Promise<any>)) as T;

      await wf.do(`step-${idx}-close`, async () => {
        await db.updateRunStep(runStepId, {
          status: "completed",
          output: output as Record<string, unknown>,
          ended_at: new Date().toISOString(),
        });
      });

      return output;
    } catch (err) {
      await wf.do(`step-${idx}-fail`, async () => {
        await db.updateRunStep(runStepId, {
          status: "failed",
          error: {
            message: err instanceof Error ? err.message : String(err),
          },
          ended_at: new Date().toISOString(),
        });
      });
      throw err;
    }
  }

  // ── Legacy synchronous mode (no Workflow binding) ─────────────────────────
  // Replay short-circuit: if the run was previously paused and is now
  // resuming, completed steps return cached output without re-executing.
  const cached = await db.getCompletedStep(ctx.runId, idx);
  if (cached !== null) return cached.output as T;

  const runStep = await db.createRunStep({
    run_id: ctx.runId,
    step_index: idx,
    step_name: name,
    step_type: "step",
    status: "running",
  });

  ctx.currentStepId = runStep.id;
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const output = await fn();
      await db.updateRunStep(runStep.id, {
        status: "completed",
        output,
        ended_at: new Date().toISOString(),
      });
      return output;
    } catch (err) {
      if (err instanceof PauseSignal) throw err;
      lastError = err;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  await db.updateRunStep(runStep.id, {
    status: "failed",
    error: {
      message: lastError instanceof Error ? lastError.message : String(lastError),
      stack: lastError instanceof Error ? lastError.stack : undefined,
    },
    ended_at: new Date().toISOString(),
  });

  throw lastError;
}
