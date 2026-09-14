/**
 * Run-level failure alerting.
 *
 * Why this exists: in July 2026 the Anthropic API ran out of credits and
 * beady/opportunity-sweep, beady/industry-day-sweep and cleo/award-sweep failed on
 * every scheduled run for days with "Your credit balance is too low to access the
 * Anthropic API", and nobody was told. The only health check in the codebase lived
 * *inside* beady/opportunity-sweep, ran before the LLM scoring step, and only looked
 * at SAM/SBIR source failures and 0-result sweeps. A run that died after that step
 * was completely silent, and the other two orchestrations had no check at all.
 *
 * So the check belongs in the engine, not in a workflow: anything that flips a run to
 * `failed` routes through failRun() here, which means every orchestration is covered
 * for free, including ones written after this file.
 *
 * Two rules govern everything below:
 *   1. Fail open. Alerting must never break a run, so every path is wrapped and the
 *      worst case is a console warning.
 *   2. Never spam. A daily cron broken for a week must not send a week of identical
 *      emails. See shouldAlert() for the suppression rules.
 */

import type { Env, RunFailureAlert } from "../types";
import { SupabaseClient } from "../db/client";
import { sendAlertEmail, subscriptionRecipients } from "../../../integrations/resend/alert";
import { senderFor } from "../../../integrations/resend/sender";

/**
 * How long the same error stays suppressed before we send a reminder. Long enough
 * that a daily cron gets at most one email per day for an ongoing breakage, short
 * enough that a real outage is not forgotten over a weekend.
 */
const COOLDOWN_HOURS = 6;

/**
 * Floor on the error-changed path. Without it, an orchestration flapping between two
 * errors (a 429 one run, a 500 the next) would alert on every single run, because the
 * fingerprint differs every time. A new error is still worth a fresh email, just not
 * more than twice an hour.
 */
const MIN_GAP_HOURS = 0.5;

/** Keeps the email readable; the full error is always in the run row. */
const ERROR_MAX_CHARS = 1200;
const HEADLINE_MAX_CHARS = 180;

type AlertReason = "first-failure" | "error-changed" | "cooldown-elapsed";

const REASON_TEXT: Record<AlertReason, string> = {
  "first-failure": "first failure since the last successful run",
  "error-changed": "the error changed from the one already alerted on",
  "cooldown-elapsed": `still failing with the same error ${COOLDOWN_HOURS}h after the last alert`,
};

/**
 * Collapse an error message to a stable signature so the same underlying breakage
 * compares equal across runs. Run ids, uuids, timestamps, hex blobs and bare numbers
 * all vary run to run and would otherwise defeat suppression entirely.
 */
function fingerprint(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "<ts>")
    .replace(/\b[0-9a-f]{16,}\b/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** First line of the error, which is nearly always the diagnostic part. */
function headline(message: string): string {
  const firstLine = message.split("\n").find((l) => l.trim().length > 0) ?? message;
  return truncate(firstLine.trim(), HEADLINE_MAX_CHARS);
}

/**
 * Known failure modes that have a specific fix. Saves the on-call reader a round trip
 * through the logs for the breakages we have actually been bitten by.
 */
function remediationHint(message: string): string | null {
  const m = message.toLowerCase();
  if (m.includes("credit balance is too low")) {
    return "The Anthropic API is out of credits, so every LLM step will keep failing. Top up at console.anthropic.com/settings/billing.";
  }
  if (m.includes("anthropic") && /\b401\b|invalid x-api-key|authentication_error/.test(m)) {
    return "Anthropic rejected the API key. Re-issue it, then: wrangler secret put ANTHROPIC_API_KEY.";
  }
  if (m.includes("sam.gov") || m.includes("sam_gov")) {
    return "SAM.gov rotates API keys roughly every 90 days. If this is a 401/403, renew the key, then: wrangler secret put SAM_GOV_API_KEY.";
  }
  if (/\b429\b|rate.?limit/.test(m)) {
    return "This looks like rate limiting. It may clear on its own; if it persists, lower the schedule frequency or the per-run batch size.";
  }
  return null;
}

function hoursSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / 3_600_000;
}

/**
 * Suppression rules, in order:
 *   - No streak on record → the orchestration was healthy, so this is news. Alert.
 *   - The error signature changed → a different breakage, worth a fresh email even
 *     mid-streak (a credit outage masking a schema bug should not stay hidden), as
 *     long as MIN_GAP_HOURS has passed.
 *   - Same error, already alerted less than COOLDOWN_HOURS ago → stay quiet.
 *   - Same error, cooldown elapsed → one reminder, then quiet again.
 */
function shouldAlert(prev: RunFailureAlert | null, fp: string, now: Date): AlertReason | null {
  if (!prev) return "first-failure";
  // A streak with no alert on record means an earlier send failed. Fall back to the
  // failure time so a broken mailer cannot become a per-run retry loop.
  const elapsed = hoursSince(prev.last_alerted_at ?? prev.last_failed_at, now);
  if (prev.error_fingerprint !== fp) return elapsed >= MIN_GAP_HOURS ? "error-changed" : null;
  return elapsed >= COOLDOWN_HOURS ? "cooldown-elapsed" : null;
}

function agentSlug(orchestrationName: string): string {
  return orchestrationName.split("/")[0] ?? "";
}

function buildFailureEmail(params: {
  orchestrationName: string;
  runId: string;
  message: string;
  failedAt: Date;
  consecutiveFailures: number;
  firstFailedAt: string;
  reason: AlertReason;
}): { subject: string; text: string } {
  const { orchestrationName, runId, message, failedAt, consecutiveFailures, firstFailedAt, reason } = params;
  const streak = consecutiveFailures > 1
    ? `${consecutiveFailures} consecutive failures, first at ${firstFailedAt}`
    : "1st failure in this streak";

  const lines = [
    // First line is the whole diagnosis: what broke and why.
    `${orchestrationName} FAILED: ${headline(message)}`,
    "",
    `Run:        ${runId}`,
    `Failed at:  ${failedAt.toISOString()}`,
    `Streak:     ${streak}`,
    `Alerting:   ${REASON_TEXT[reason]}`,
  ];

  const hint = remediationHint(message);
  if (hint) lines.push("", `Likely fix: ${hint}`);

  lines.push("", "Error:", truncate(message, ERROR_MAX_CHARS));
  lines.push(
    "",
    `Further alerts for this same error are suppressed for ${COOLDOWN_HOURS}h. You will get one more email when ${orchestrationName} succeeds again.`,
  );

  return {
    subject: `🚨 ${orchestrationName} failed: ${truncate(headline(message), 80)}`,
    text: lines.join("\n"),
  };
}

/** Returns whether the email actually went out. Never throws. */
async function emailAlert(env: Env, orchestrationName: string, subject: string, text: string): Promise<boolean> {
  try {
    // A failed run is an operational page, not business news (#233).
    const to = await subscriptionRecipients(env, "alert");
    const result = await sendAlertEmail(env, { to, subject, text, from: senderFor(env, agentSlug(orchestrationName)) });
    if (!result.sent) console.warn(`[run-alert] ${orchestrationName}: not emailed (${result.error ?? "unknown"})`);
    return result.sent;
  } catch (err) {
    console.warn(`[run-alert] ${orchestrationName}: send threw:`, err);
    return false;
  }
}

/**
 * Record a run failure and email about it unless suppressed. Never throws.
 *
 * Kept separate from failRun() so a caller that has already written
 * `status = 'failed'` itself can still opt in without restructuring.
 */
export async function notifyRunFailure(
  env: Env,
  params: { runId: string; orchestrationName: string; message: string; failedAt?: Date },
): Promise<void> {
  try {
    const { runId, orchestrationName, message } = params;
    const failedAt = params.failedAt ?? new Date();
    const db = new SupabaseClient(env);
    const fp = fingerprint(message);
    const prev = await db.getRunFailureAlert(orchestrationName);

    // Cloudflare can replay a Workflow instance, which would re-enter this path for a
    // run we already counted. Same run id means same failure: leave the ledger alone.
    if (prev && prev.last_failed_run_id === runId) return;

    const reason = shouldAlert(prev, fp, failedAt);
    const consecutiveFailures = (prev?.consecutive_failures ?? 0) + 1;
    const firstFailedAt = prev && prev.error_fingerprint === fp ? prev.first_failed_at : failedAt.toISOString();

    // Send before recording, so last_alerted_at only ever reflects an email that
    // really went out. emailAlert() cannot throw, so the ledger write below always
    // happens and the streak count stays honest either way.
    let alerted = false;
    if (reason) {
      const { subject, text } = buildFailureEmail({
        orchestrationName,
        runId,
        message,
        failedAt,
        consecutiveFailures,
        firstFailedAt,
        reason,
      });
      alerted = await emailAlert(env, orchestrationName, subject, text);
    } else {
      console.log(`[run-alert] ${orchestrationName}: failure ${consecutiveFailures} suppressed (same error, within ${COOLDOWN_HOURS}h cooldown)`);
    }

    await db.upsertRunFailureAlert({
      orchestration_name: orchestrationName,
      error_fingerprint: fp,
      last_error: truncate(message, ERROR_MAX_CHARS),
      consecutive_failures: consecutiveFailures,
      last_failed_run_id: runId,
      first_failed_at: firstFailedAt,
      last_failed_at: failedAt.toISOString(),
      last_alerted_at: alerted ? failedAt.toISOString() : (prev?.last_alerted_at ?? null),
    });
  } catch (err) {
    // Fail open: an alerting problem must never surface as a run problem.
    console.warn(`[run-alert] alerting failed for ${params.orchestrationName}:`, err);
  }
}

/**
 * Flip a run to `failed` and alert on it. Every run-level failure transition in the
 * runtime goes through here, which is what makes the coverage generic: a new
 * orchestration is alerted on without its author doing anything.
 *
 * The status write is deliberately *not* swallowed (a run that cannot be marked failed
 * is a real problem); only the alerting is.
 */
export async function failRun(
  db: SupabaseClient,
  env: Env,
  params: { runId: string; orchestrationName: string; message: string; failedAt?: Date },
): Promise<void> {
  const failedAt = params.failedAt ?? new Date();
  await db.updateRun(params.runId, {
    status: "failed",
    error: { message: params.message },
    ended_at: failedAt.toISOString(),
  });
  await notifyRunFailure(env, {
    runId: params.runId,
    orchestrationName: params.orchestrationName,
    message: params.message,
    failedAt,
  });
}

/**
 * Clear the failure streak after a successful run, and send a recovery notice if we
 * had emailed about the streak. One delete-returning per successful run, and it can
 * only ever fire once per streak, so it adds no spam risk. Never throws.
 */
export async function notifyRunSuccess(env: Env, orchestrationName: string): Promise<void> {
  try {
    const db = new SupabaseClient(env);
    const cleared = await db.clearRunFailureAlert(orchestrationName);
    if (!cleared || !cleared.last_alerted_at) return;

    const text = [
      `${orchestrationName} is succeeding again.`,
      "",
      `Recovered at:  ${new Date().toISOString()}`,
      `Streak ended:  ${cleared.consecutive_failures} consecutive failure(s) since ${cleared.first_failed_at}`,
      "",
      "Last error was:",
      truncate(cleared.last_error ?? "(not recorded)", ERROR_MAX_CHARS),
    ].join("\n");

    await emailAlert(env, orchestrationName, `✅ ${orchestrationName} recovered`, text);
  } catch (err) {
    console.warn(`[run-alert] recovery notice failed for ${orchestrationName}:`, err);
  }
}
