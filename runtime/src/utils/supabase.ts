import type { Env } from "../types";

// Standard Supabase REST (PostgREST) headers for service-role calls. The runtime is
// trusted and runs as `service_role`, so every call carries the service-role key as
// both `apikey` and bearer `Authorization`. Pass `profile` to target a non-public
// Postgres schema (PostgREST reads `Accept-Profile` for reads and `Content-Profile`
// for writes; both are set to the same value). `extra` merges in per-call headers
// such as `Prefer`.
export function sbHeaders(
  env: Env,
  opts?: { profile?: string; extra?: Record<string, string> },
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
  if (opts?.profile !== undefined) {
    headers["Accept-Profile"] = opts.profile;
    headers["Content-Profile"] = opts.profile;
  }
  if (opts?.extra) Object.assign(headers, opts.extra);
  return headers;
}
