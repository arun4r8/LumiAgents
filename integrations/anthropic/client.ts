import Anthropic from "@anthropic-ai/sdk";

/**
 * The one place an Anthropic client is constructed.
 *
 * WHY THIS EXISTS
 *   Twelve call sites each did `new Anthropic({ apiKey })` and none set a timeout or a
 *   retry bound. The SDK defaults to a 10-minute timeout with 2 retries, so a single
 *   stalled request occupies a step for up to THIRTY MINUTES before it fails -- and on
 *   the durable Workflow path the step is then retried on top of that.
 *
 *   Observed on beady/govcon-assessment: `executive-memo` (max_tokens 1024, an 8KB
 *   prompt) sat "running" for 36 minutes with no error, no output, and nothing in the
 *   logs. The same step on the same orchestration had taken 13 seconds an hour earlier.
 *   A run that hangs silently is worse than one that fails: nothing alerts, the UI shows
 *   "running", and the only way to notice is to go looking.
 *
 * THE DEFAULTS
 *   timeout 5 minutes, 1 retry -> ~10 minutes worst case instead of ~30, and a real
 *   error at the end of it. Generous for ordinary calls: the memo needs 13 seconds, and
 *   the heaviest scoring step in that orchestration takes 48.
 *
 *   Genuinely long generations (large drafting calls) can raise it per call site rather
 *   than every caller inheriting a bound set for the slowest one.
 */
export interface AnthropicClientOptions {
  /** Override the per-request timeout in ms. Raise it for long drafting calls. */
  timeoutMs?: number;
  /** Override the retry count. Keep it low: retries multiply the timeout. */
  maxRetries?: number;
}

export const ANTHROPIC_DEFAULT_TIMEOUT_MS = 300_000;
export const ANTHROPIC_DEFAULT_MAX_RETRIES = 1;

export function anthropicClient(apiKey: string, opts?: AnthropicClientOptions): Anthropic {
  return new Anthropic({
    apiKey,
    timeout: opts?.timeoutMs ?? ANTHROPIC_DEFAULT_TIMEOUT_MS,
    maxRetries: opts?.maxRetries ?? ANTHROPIC_DEFAULT_MAX_RETRIES,
  });
}
