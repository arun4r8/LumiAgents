import { createClient } from "@/lib/supabase/server";

/**
 * Assert the current request is made by an authenticated ops user.
 *
 * Roles live in `auth.users.app_metadata.role` ('ops' | 'enduser'). Call this at
 * the top of every admin action BEFORE touching the service-role admin client.
 * Throws "Forbidden: ops only" when the caller is not an ops user.
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
