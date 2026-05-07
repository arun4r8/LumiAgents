/**
 * Thrown by await_approval when a decision is still pending.
 * Caught by the runner, which marks the run "paused" and returns 202.
 * On resume the orchestration is replayed; completed steps short-circuit
 * via their cached run_steps output.
 */
export class PauseSignal extends Error {
  readonly approvalId: string;
  constructor(approvalId: string) {
    super(`Run paused — awaiting approval ${approvalId}`);
    this.name = "PauseSignal";
    this.approvalId = approvalId;
  }
}
