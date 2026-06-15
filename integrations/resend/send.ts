import type { Env } from "../../runtime/src/types";

// Send a transactional email via Resend. Degrades gracefully: returns
// { sent: false } (and logs) if RESEND_API_KEY is unset or the call fails, so a
// missing key never breaks the report run.
export async function sendEmail(
  env: Env,
  opts: { to: string[]; subject: string; html: string },
): Promise<{ sent: boolean; id?: string; error?: string }> {
  if (!env.RESEND_API_KEY) return { sent: false, error: "RESEND_API_KEY not set" };
  if (opts.to.length === 0) return { sent: false, error: "no recipients" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.RESEND_FROM ?? "Beady <onboarding@resend.dev>",
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      }),
    });
    if (!res.ok) {
      const error = `Resend → ${res.status}: ${await res.text()}`;
      console.warn("[resend]", error);
      return { sent: false, error };
    }
    const data = (await res.json()) as { id?: string };
    return { sent: true, ...(data.id ? { id: data.id } : {}) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn("[resend] send error:", error);
    return { sent: false, error };
  }
}
