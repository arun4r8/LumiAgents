import type { Env } from "../../runtime/src/types";
import { sendEmail } from "./send";

// Emails go to the people subscribed to a KIND of mail, pulled live from
// orchestration.subscriptions: 'opportunity' and 'award' are business digests,
// 'alert' is the operational page list (#233). An optional ALERT_EMAIL env var adds
// fixed recipients on top. Degrades gracefully: if there are no recipients or
// RESEND_API_KEY is unset, it logs and returns { sent: false } so a run never breaks.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function envRecipients(env: Env): string[] {
  return (env.ALERT_EMAIL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export type SubscriptionKind = "opportunity" | "award" | "alert";

/**
 * Distinct recipients of the active subscriptions of the given kind(s).
 *
 * The kind is REQUIRED. It used to be optional, and every operational alert called
 * this without one -- which returned the recipients of EVERY subscription, i.e. the
 * business digest list. So a failed run, a broken sweep and the watchdog all paged
 * the one person subscribed to the GovCon digest, and nobody who could fix anything
 * (#233). With 'alert' rows now in the same table, an unfiltered call would also
 * send business digests' audiences every page, and every page to the digest list.
 * Making the caller name its audience is what stops either leak.
 */
export async function subscriptionRecipients(env: Env, kind: SubscriptionKind | SubscriptionKind[]): Promise<string[]> {
  try {
    const kinds = Array.isArray(kind) ? kind : [kind];
    // An empty list must not become "no filter": that is the bug this signature fixes.
    if (kinds.length === 0) return [];
    const filter = kinds.length === 1 ? `kind=eq.${kinds[0]}` : `kind=in.(${kinds.join(",")})`;
    const url = `${env.SUPABASE_URL}/rest/v1/subscriptions?is_active=eq.true&${filter}&select=recipients`;
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Accept-Profile": "orchestration",
      },
    });
    if (!res.ok) { console.warn(`[alert] subscription lookup → ${res.status}`); return []; }
    const rows = (await res.json()) as Array<{ recipients: string[] | null }>;
    return [...new Set(rows.flatMap((r) => r.recipients ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  } catch (e) {
    console.warn("[alert] subscription lookup failed:", e);
    return [];
  }
}

export async function sendAlertEmail(
  env: Env,
  opts: { to: string[]; subject: string; text: string; from?: string },
): Promise<{ sent: boolean; recipients: number; error?: string }> {
  const to = [...new Set([...opts.to.map((e) => e.trim().toLowerCase()), ...envRecipients(env)])].filter(Boolean);
  if (to.length === 0) {
    console.warn(`[alert] no recipients, alert not emailed: ${opts.subject}`);
    return { sent: false, recipients: 0, error: "no recipients" };
  }
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111">
<p style="white-space:pre-wrap">${escapeHtml(opts.text)}</p>
<hr style="border:none;border-top:1px solid #eee;margin:16px 0">
<p style="font-size:12px;color:#888">Automated alert from LumiAgents.</p>
</div>`;
  const r = await sendEmail(env, { to, subject: opts.subject, html, ...(opts.from ? { from: opts.from } : {}) });
  return { sent: r.sent, recipients: to.length, ...(r.error ? { error: r.error } : {}) };
}
