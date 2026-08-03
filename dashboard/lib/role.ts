import type { User } from "@supabase/supabase-js";

export type Role = "ops" | "enduser";

/**
 * Resolve a user's role for UI decisions.
 *
 * The source of truth is `auth.users.app_metadata.role` ('ops' | 'enduser'),
 * surfaced as the `user_role` JWT claim. We read `app_metadata.role` first, then
 * fall back to the `user_role` claim / `user_metadata.role` only if one is already
 * present. Anything unknown defaults to "enduser" (least privilege).
 */
export function roleOf(
  user:
    | Pick<User, "app_metadata" | "user_metadata">
    | { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }
    | null
    | undefined,
): Role {
  const appMeta = (user?.app_metadata ?? {}) as Record<string, unknown>;
  const userMeta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const raw = appMeta.role ?? appMeta.user_role ?? userMeta.role;
  return raw === "ops" ? "ops" : "enduser";
}
