import type { User } from "@supabase/supabase-js";

export type Role = "ops" | "enduser";

/**
 * Resolve a user's role for UI decisions.
 *
 * The source of truth is `auth.users.app_metadata.role` ('ops' | 'enduser'),
 * surfaced as the `user_role` JWT claim. Anything unknown defaults to "enduser"
 * (least privilege).
 *
 * `user_metadata.role` is deliberately NOT consulted. That object is writable by
 * the user's own browser session with the public anon key -- this app writes to it
 * in components/topbar.tsx and components/first-run-note.tsx -- so honouring a role
 * from it lets any account with no `app_metadata.role` promote itself by calling
 * `supabase.auth.updateUser({ data: { role: "ops" } })` from the console. Roleless
 * accounts are a real transient state: inviteMember creates the user first and
 * stamps the role second, so a failure between the two leaves one behind.
 *
 * Postgres was never fooled by this -- `is_ops()` reads only the `user_role` claim
 * and `app_metadata.role` -- but requireOps() gates the service-role client, which
 * bypasses RLS entirely, so the mismatch mattered there.
 */
export function roleOf(
  user:
    | Pick<User, "app_metadata" | "user_metadata">
    | { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }
    | null
    | undefined,
): Role {
  const appMeta = (user?.app_metadata ?? {}) as Record<string, unknown>;
  const raw = appMeta.role ?? appMeta.user_role;
  return raw === "ops" ? "ops" : "enduser";
}
