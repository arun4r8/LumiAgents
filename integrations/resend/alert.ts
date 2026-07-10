import type { Env } from "../../runtime/src/types";
import { sendEmail } from "./send";

// Operational failure alerts (sweep health, content-calendar nudge, …) go out by
// email to *the people subscribed* — the recipients of the active digests, pulled live
// from orchestration.subscriptions. An optional ALERT_EMAIL env var adds fixed
// recipients on top. Degrades gracefully: if there are no recipients or RESEND_API_KEY
// is unset, it logs and returns { sent: false } so a run never breaks.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function envRecipients(env: Env): string[] {
  return (env.ALERT_EMAIL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Distinct recipients of active subscriptions (optionally of one kind). These are the
// people who receive the digests, so they're who should hear when a source breaks.
export async function subscriptionRecipients(env: Env, kind?: "opportunity" | "award"): Promise<string[]> {
  try {
    const url = `${env.SUPABASE_URL}/rest/v1/subscriptions?is_active=eq.true&select=recipients${kind ? `&kind=eq.${kind}` : ""}`;
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
    console.warn(`[alert] no recipients — alert not emailed: ${opts.subject}`);
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
