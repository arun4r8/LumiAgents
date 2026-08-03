import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Standard Supabase SSR confirm endpoint. The invite link points here; verifying
 * the OTP establishes the session via cookies, then we redirect to `next`
 * (default /accept) where the invitee sets their password.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  // Only allow same-origin relative paths — guard against open-redirect via `next`.
  const nextParam = searchParams.get("next") ?? "/accept";
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/accept";

  if (token_hash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  return NextResponse.redirect(new URL("/login?error=invite_invalid", origin));
}
