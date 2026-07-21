// Per-agent database identity: how a Worker obtains a credential that Postgres can
// recognise as "this agent". See docs/agent-identity.md for the full design.
//
// An agent credential is a short-lived HS256 JWT signed with SUPABASE_JWT_SECRET, the
// same secret and the same shape as the existing agent-dispatch token minted in
// runtime/src/routes/agents.ts. It carries role: "authenticated" so PostgREST switches
// to the ordinary `authenticated` Postgres role (every existing GRANT keeps working),
// plus a custom `agent` claim that public.current_agent() resolves against
// orchestration.agent_identities.
//
// INERT BY DEFAULT: nothing calls mintAgentToken unless AGENT_DB_IDENTITY is set to
// "enforce" AND the matching orchestration.agent_identities row has is_active = true.
// Both switches ship off. This module adds a capability; it does not turn anything on
// and it removes no existing access path.

import type { Env } from "../types";

// `sub` must parse as a uuid: Supabase's auth.uid() is (auth.jwt() ->> 'sub')::uuid, and
// several existing enduser policies call it. A non-uuid subject would make those
// policies raise a cast error for any agent request that happens to touch such a table.
// The nil uuid parses, matches no auth.users row, and keeps the real identity in the
// `agent` claim where the policies actually look for it.
const AGENT_SUBJECT_UUID = "00000000-0000-0000-0000-000000000000";

// Short by design. The credential is minted per retrieval call, so revocation latency is
// bounded by this TTL even before the is_active kill switch is considered.
const DEFAULT_TTL_SECONDS = 300;

function base64Url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlBytes(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Mint a database credential for one agent. The claim set is the contract; the issuer is
 * an implementation detail, so this can later be replaced by a Supabase Auth service
 * account without touching a single RLS policy.
 */
export async function mintAgentToken(
  jwtSecret: string,
  agentSlug: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      sub: AGENT_SUBJECT_UUID,
      // PostgREST reads this to pick the Postgres role. It must stay "authenticated".
      role: "authenticated",
      // The identity itself. public.current_agent() reads exactly this claim.
      agent: agentSlug,
      aud: "authenticated",
      iat: now,
      exp: now + ttlSeconds,
    }),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(jwtSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlBytes(signature)}`;
}

/**
 * Master switch for database-enforced agent access. Defaults OFF: only the exact string
 * "enforce" enables it, so an unset or misspelled variable leaves the runtime-only gate
 * in place rather than half-enabling anything.
 */
export function isAgentDbIdentityEnabled(env: Env): boolean {
  return env.AGENT_DB_IDENTITY === "enforce" && Boolean(env.SUPABASE_JWT_SECRET);
}

/**
 * Supabase REST headers that authenticate as an agent rather than as the service role.
 * The `apikey` header only gets the request past the API gateway; the Postgres role and
 * the agent claim both come from the Authorization JWT.
 */
export async function agentAuthHeaders(
  env: Env,
  agentSlug: string,
): Promise<Record<string, string>> {
  const token = await mintAgentToken(env.SUPABASE_JWT_SECRET, agentSlug);
  return {
    apikey: env.SUPABASE_ANON_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${token}`,
  };
}
