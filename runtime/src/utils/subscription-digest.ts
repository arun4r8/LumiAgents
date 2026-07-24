// Shared machinery for the subscription-driven email digests (beady/opportunity-report
// and cleo/award-report). Those two orchestrations are near-identical twins: both load
// their kind's active subscriptions from the unified `orchestration.subscriptions`
// table, honour a per-subscription daily/weekly cadence, render a stacked-card HTML
// email, send it via Resend under the agent's own identity, and stamp `last_sent_at`.
//
// This module owns the parts that are byte-for-byte identical between them — the
// subscription CRUD, the cadence check, the run loop, and the outer email shell — and
// leaves the genuinely-divergent parts (each kind's record query and per-item card
// rendering) to the caller via `loadRecords` / `renderEmail`.

import type { Env, RunContext } from "../types";
import { step } from "../primitives/step";
import { sbHeaders } from "./supabase";
import { escapeHtml } from "./format";
import { sendEmail } from "../../../integrations/resend/send";
import { senderFor } from "../../../integrations/resend/sender";

// ─── Shared subscription shape ─────────────────────────────────────────────────

// Fields every digest subscription has, regardless of kind. Callers extend this with
// their kind-specific filter columns (e.g. `sources`/`agencies` or `award_types`) and
// pass the matching `select=` column list as `subColumns`.
export interface DigestSubscription {
  id: string;
  label: string | null;
  cadence: "daily" | "weekly";
  recipients: string[];
  last_sent_at: string | null;
}

// ─── Supabase REST helpers (service role; runtime is trusted) ──────────────────
// subscriptions lives in the `orchestration` schema → PostgREST needs the
// Accept-Profile / Content-Profile headers to reach it. Rows are the kind-typed
// slice of the unified subscriptions table.

async function loadActiveSubscriptions<Sub extends DigestSubscription>(
  env: Env,
  kind: string,
  columns: string,
): Promise<Sub[]> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?kind=eq.${kind}&is_active=eq.true&select=${columns}`,
    { headers: sbHeaders(env, { profile: "orchestration" }) },
  );
  if (!res.ok) throw new Error(`load ${kind} subscriptions → ${res.status}: ${await res.text()}`);
  return (await res.json()) as Sub[];
}

// One subscription by id (for the manual "Send now" path; active or not).
async function loadSubscriptionById<Sub extends DigestSubscription>(
  env: Env,
  kind: string,
  columns: string,
  id: string,
): Promise<Sub | null> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?id=eq.${id}&kind=eq.${kind}&select=${columns}`,
    { headers: sbHeaders(env, { profile: "orchestration" }) },
  );
  if (!res.ok) throw new Error(`load ${kind} subscription ${id} → ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as Sub[];
  return rows[0] ?? null;
}

async function markSent(env: Env, id: string, sentAt: string): Promise<void> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?id=eq.${id}`,
    {
      method: "PATCH",
      headers: sbHeaders(env, { profile: "orchestration", extra: { Prefer: "return=minimal" } }),
      body: JSON.stringify({ last_sent_at: sentAt, updated_at: sentAt }),
    },
  );
  if (!res.ok) throw new Error(`mark ${id} sent → ${res.status}: ${await res.text()}`);
}

// ─── Cadence ───────────────────────────────────────────────────────────────────

// Daily subs are always due. Weekly subs are due if never sent or last sent ≳6.5
// days ago (slack so a daily cron that drifts by a few minutes still fires weekly
// on the 7th day rather than skipping to day 8).
export function isDue(sub: DigestSubscription, now: number): boolean {
  if (sub.cadence === "daily") return true;
  if (!sub.last_sent_at) return true;
  const elapsedDays = (now - new Date(sub.last_sent_at).getTime()) / 86_400_000;
  return elapsedDays >= 6.5;
}

// ─── Shared HTML shell ─────────────────────────────────────────────────────────

// A key/value row inside a card's detail table. Identical across digests.
export function digestKv(label: string, value: string): string {
  return `<tr><td style="color:#6b7280;font-size:12px;padding:2px 14px 2px 0;white-space:nowrap;vertical-align:top;">${label}</td><td style="color:#374151;font-size:13px;padding:2px 0;vertical-align:top;">${value}</td></tr>`;
}

// The outer email chrome: `<body>` wrapper, heading, filter subline, the caller's
// pre-rendered `cards`, and the footer. `label` is escaped; `footer` is trusted HTML
// (it carries a literal `&rarr;` entity).
export function renderDigestShell(opts: {
  heading: string;
  label: string;
  cadence: string;
  filterBits: string[];
  cards: string;
  footer: string;
}): string {
  return `<!doctype html>
<html>
<body style="margin:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <h1 style="font-size:20px;color:#111827;margin:0 0 4px;">${opts.heading}</h1>
    <p style="color:#6b7280;margin:0 0 16px;font-size:14px;">
      ${escapeHtml(opts.label)} · ${opts.cadence} · ${escapeHtml(opts.filterBits.join(" · "))}
    </p>
    ${opts.cards}
    <p style="color:#9ca3af;font-size:12px;margin-top:16px;">
      ${opts.footer}
    </p>
  </div>
</body>
</html>`;
}

// ─── Run loop ──────────────────────────────────────────────────────────────────

export interface SubscriptionDigestConfig<Sub extends DigestSubscription, Item> {
  // subscription `kind` and the `select=` column list for that kind's rows.
  kind: string;
  subColumns: string;
  // agent slug for the "from" identity (senderFor(env, sender)).
  sender: string;
  // per-subscription step name prefix → step id `${stepPrefix}-${sub.id}`.
  stepPrefix: string;
  // reason strings recorded on an empty digest (manual vs cron paths).
  emptyReasonManual: string;
  emptyReasonCron: string;
  // load this subscription's digest items. sinceLastSent=true (cron) → only items new
  // since last send; false (manual) → the full current digest.
  loadRecords: (env: Env, sub: Sub, opts: { sinceLastSent: boolean }) => Promise<Item[]>;
  // render the email for a non-empty item set.
  renderEmail: (sub: Sub, items: Item[], opts: { manual: boolean }) => { subject: string; html: string };
}

export interface DigestResult {
  subscriptionsDue: number;
  emailsSent: number;
  emailsSkipped: number;
}

// The shared digest orchestration body. Cron path: process every active, due
// subscription with recipients, sending only items new since its last send; a
// subscription with nothing new is still stamped (so weekly cadence advances) but no
// empty email goes out. Manual ("Send now") path: process only the given subscription,
// bypass the cadence check, send the full current digest, and stamp nothing when there
// is nothing to send (the regular schedule is left untouched). last_sent_at only
// advances on a real send, so a failed/disabled send is retried next run.
export async function runSubscriptionDigest<Sub extends DigestSubscription, Item>(
  ctx: RunContext,
  input: { subscriptionId?: string | undefined },
  config: SubscriptionDigestConfig<Sub, Item>,
): Promise<DigestResult> {
  const manual = Boolean(input.subscriptionId);

  const subscriptions = await step(ctx, "load-subscriptions", async () => {
    if (manual) {
      const sub = await loadSubscriptionById<Sub>(ctx.env, config.kind, config.subColumns, input.subscriptionId!);
      if (!sub) return [];
      return Array.isArray(sub.recipients) && sub.recipients.length > 0 ? [sub] : [];
    }
    const all = await loadActiveSubscriptions<Sub>(ctx.env, config.kind, config.subColumns);
    const now = Date.now();
    return all.filter((s) => Array.isArray(s.recipients) && s.recipients.length > 0 && isDue(s, now));
  });

  let emailsSent = 0;
  let emailsSkipped = 0;

  // One checkpointed step per subscription: query → render → send → stamp.
  for (const sub of subscriptions) {
    const outcome = await step(ctx, `${config.stepPrefix}-${sub.id}`, async () => {
      const sentAt = new Date().toISOString();
      const items = await config.loadRecords(ctx.env, sub, { sinceLastSent: !manual });

      if (items.length === 0) {
        if (!manual) await markSent(ctx.env, sub.id, sentAt);
        return { sent: false as const, reason: manual ? config.emptyReasonManual : config.emptyReasonCron };
      }

      const { subject, html } = config.renderEmail(sub, items, { manual });
      const result = await sendEmail(ctx.env, {
        to: sub.recipients,
        subject,
        html,
        from: senderFor(ctx.env, config.sender),
      });

      if (result.sent) {
        await markSent(ctx.env, sub.id, sentAt);
        return { sent: true as const, count: items.length };
      }
      return { sent: false as const, reason: result.error ?? "send-failed" };
    });

    if (outcome.sent) emailsSent++;
    else emailsSkipped++;
  }

  return {
    subscriptionsDue: subscriptions.length,
    emailsSent,
    emailsSkipped,
  };
}
