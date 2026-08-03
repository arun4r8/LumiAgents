import { createClient } from "@supabase/supabase-js";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Service-role Supabase client.
 *
 * WARNING: this client uses the SUPABASE_SERVICE_ROLE_KEY. It BYPASSES RLS and
 * can create, update, and delete users (auth.admin.*). It must NEVER be imported
 * into a client component, and it must only be called AFTER verifying the caller
 * is an ops user (see `requireOps()`). Server-only.
 */
export function createAdminClient() {
  // Cloudflare worker secrets are exposed via the runtime env, not process.env,
  // in production. Fall back to process.env for local `next dev`.
  let cfEnv: Record<string, string | undefined> = {};
  try {
    cfEnv = getCloudflareContext().env as unknown as Record<string, string | undefined>;
  } catch {
    // Not running inside the Cloudflare context (e.g. local dev / build) — use process.env.
  }

  const url = cfEnv.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey =
    cfEnv.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL for admin client.");
  }
  if (!serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY. Provision it as a Cloudflare worker secret before inviting users.",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
