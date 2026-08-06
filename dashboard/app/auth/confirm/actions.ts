"use server";

import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Verify an invite / recovery OTP. Deliberately a Server Action (POST) rather
 * than the GET route handler this replaced.
 *
 * Why: `verifyOtp` CONSUMES a single-use token. When the endpoint was a plain
 * GET, anything that fetched the URL burned the token before its recipient ever
 * clicked — and links pasted into Teams, Slack or email are fetched routinely by
 * preview unfurlers and by mail-security scanners (Defender Safe Links and
 * friends). We watched it happen: an invite generated at 13:30:00 was consumed
 * at 13:30:05, 3.8 seconds BEFORE the message carrying it was even sent, so the
 * invitee's first click always landed on /login?error=invite_invalid. Nothing
 * was wrong with the token, the project's URL config, or the expiry — the link
 * had simply already been spent by a robot.
 *
 * Unfurlers and scanners issue GET, not POST, and they do not submit forms. So
 * the token now survives until a human presses Continue.
 */
export async function confirmOtp(formData: FormData): Promise<{ error: string }> {
  const tokenHash = String(formData.get("token_hash") ?? "");
  const type = String(formData.get("type") ?? "") as EmailOtpType;

  // Same open-redirect guard the GET route carried: only same-origin relative
  // paths, and never a protocol-relative `//evil.com`.
  const rawNext = String(formData.get("next") ?? "/accept");
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/accept";

  if (!tokenHash || !type) {
    return { error: "This link is missing information. Ask for a new invite." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error) {
    // Single-use and time-limited: an already-accepted invite and a genuinely
    // expired one both land here, and Supabase does not reliably distinguish
    // them. Say what to do rather than guessing which it was.
    return {
      error:
        "This link is no longer valid. It may have already been used, or it may have expired. Ask for a new invite.",
    };
  }

  redirect(next);
}
