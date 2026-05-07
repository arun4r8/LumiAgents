import type { RunContext } from "../types";
import { SupabaseClient } from "../db/client";
import { PauseSignal } from "./pause";

const RETRY_DELAYS_MS = [1000, 3000, 10000]; // exponential-ish backoff

export async function step<T>(
  ctx: RunContext,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const db = new SupabaseClient(ctx.env);
  const idx = ctx.stepIndex();

  // ── Replay short-circuit ──────────────────────────────────────────────────
  // If this run was previously paused and is now resuming, completed steps
  // return their cached output rather than re-executing. This makes replay
  // safe and idempotent.
  const cached = await db.getCompletedStep(ctx.runId, idx);
  if (cached !== null) {
    return cached.output as T;
  }

  const runStep = await db.createRunStep({
    run_id: ctx.runId,
    step_index: idx,
    step_name: name,
    step_type: "step",
    status: "running",
  });

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
      // Don't retry PauseSignals — propagate immediately
      if (err instanceof PauseSignal) throw err;

      lastError = err;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const error = {
    message: lastError instanceof Error ? lastError.message : String(lastError),
    stack: lastError instanceof Error ? lastError.stack : undefined,
  };

  await db.updateRunStep(runStep.id, {
    status: "failed",
    error,
    ended_at: new Date().toISOString(),
  });

  throw lastError;
}
