import { createClient } from "@/lib/supabase/server";

/**
 * Assert the current request is made by an authenticated ops user.
 *
 * Roles live in `auth.users.app_metadata.role` ('ops' | 'enduser'), which only the
 * service role can write. Call this at the top of every admin action BEFORE
 * touching the service-role admin client. Throws "Forbidden: ops only" when the
 * caller is not an ops user.
 *
 * This reads `app_metadata` directly rather than going through `roleOf()`. The two
 * agree today, and roleOf() is the right helper for nav and per-page checks -- but
 * this call gates a client that bypasses RLS and can delete users, so it does not
 * delegate its decision to a shared UI helper whose definition of "role" could be
 * widened later. It was widened once already: routing this through roleOf() while
 * roleOf() still honoured the client-writable `user_metadata.role` briefly made
 * self-promotion to service-role access possible for any roleless account.
 */
export async function requireOps() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.app_metadata?.role !== "ops") {
    throw new Error("Forbidden: ops only");
  }

  return user;
}
