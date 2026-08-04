// GitHub App authentication for the Tier 2 agent builder (#67).
//
// The Tier 2 codegen flow opens PRs against LumitureLabs/LumiAgents. That write power must
// NOT ride on GITHUB_API_TOKEN (the read-only vault credential scoped to a different repo).
// Instead a dedicated GitHub App — installed on LumitureLabs/LumiAgents with Contents:write +
// Pull requests:write and nothing else — provides a stable, installation-scoped identity that
// can open a PR but can never merge one (the human merge is the whole governance gate).
//
// Flow: mint a short-lived RS256 JWT (iss = GH_APP_ID, exp ≤ 10 min) signed with the App's
// private key via WebCrypto, POST it to the installation access-tokens endpoint, and cache the
// resulting installation token in module scope until ~1 min before it expires.
//
// The three secrets (GH_APP_ID / GH_APP_INSTALLATION_ID / GH_APP_PRIVATE_KEY) are provisioned
// out-of-band and are ABSENT in CI; requireAppSecrets() fails loudly and every caller guards on
// it, so their absence never breaks the build or unrelated code paths.

import type { Env } from "../../types";

const GITHUB_API = "https://api.github.com";

// The installation token is cached across requests in the same isolate. Cleared implicitly by
// isolate recycling; refreshed here ~1 min before expiry.
let cachedToken: { token: string; expiresAtMs: number } | null = null;

/** Reset the module-scope token cache. Exposed for tests; not used on the request path. */
export function _resetInstallationTokenCache(): void {
  cachedToken = null;
}

/** Throw a clear, actionable error if any GitHub App secret is missing. */
export function requireAppSecrets(env: Env): void {
  const missing: string[] = [];
  if (!env.GH_APP_ID) missing.push("GH_APP_ID");
  if (!env.GH_APP_INSTALLATION_ID) missing.push("GH_APP_INSTALLATION_ID");
  if (!env.GH_APP_PRIVATE_KEY) missing.push("GH_APP_PRIVATE_KEY");
  if (missing.length > 0) {
    throw new Error(
      `GitHub App auth is not configured: missing ${missing.join(", ")}. ` +
        `An ops engineer must provision these runtime secrets out-of-band ` +
        `(wrangler secret put) before the Tier 2 agent builder can open PRs.`,
    );
  }
}

/** True when all three App secrets are present. Lets callers guard without throwing. */
export function hasAppSecrets(env: Env): boolean {
  return Boolean(env.GH_APP_ID && env.GH_APP_INSTALLATION_ID && env.GH_APP_PRIVATE_KEY);
}

// ─── base64url helpers ──────────────────────────────────────────────────────────

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8ToBase64Url(str: string): string {
  return bytesToBase64Url(new TextEncoder().encode(str));
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ─── JWT claims (pure, testable) ─────────────────────────────────────────────────

export interface AppJwtClaims {
  iss: string;
  iat: number;
  exp: number;
}

/**
 * Build the GitHub App JWT claim set. iat is backdated 60s to tolerate clock drift; exp is
 * 8 minutes out, so the total lifetime (exp - iat = 540s) stays under GitHub's 10-minute cap.
 */
export function buildJwtClaims(appId: string, nowSec: number): AppJwtClaims {
  return { iss: appId, iat: nowSec - 60, exp: nowSec + 480 };
}

/**
 * GH_APP_PRIVATE_KEY is the base64 of a PKCS8 PEM. Decode base64 → PEM string, strip the
 * header/footer + whitespace, base64-decode the body → the raw PKCS8 DER bytes for importKey.
 */
export function pkcs8DerFromEnvKey(base64Pem: string): ArrayBuffer {
  const pem = new TextDecoder().decode(base64ToBytes(base64Pem.trim()));
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const der = base64ToBytes(body);
  // Return a fresh ArrayBuffer sized exactly to the DER bytes.
  return der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer;
}

/**
 * Mint an RS256-signed GitHub App JWT. Pure aside from WebCrypto; no network. `nowSec` is
 * injectable for deterministic tests.
 */
export async function mintAppJwt(
  env: Env,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  requireAppSecrets(env);
  const header = utf8ToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = buildJwtClaims(env.GH_APP_ID as string, nowSec);
  const payload = utf8ToBase64Url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8DerFromEnvKey(env.GH_APP_PRIVATE_KEY as string),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

// ─── Installation token ───────────────────────────────────────────────────────────

interface TokenDeps {
  fetch: typeof fetch;
  now: () => number;
}

const DEFAULT_TOKEN_DEPS: TokenDeps = { fetch: (...a) => fetch(...a), now: () => Date.now() };

/**
 * Return a cached installation token, or mint a fresh JWT and exchange it for one. Cached in
 * module scope until ~1 min before expiry. `deps` is injectable so tests can supply a fake
 * fetch + clock and never touch the network.
 */
export async function getInstallationToken(
  env: Env,
  deps: TokenDeps = DEFAULT_TOKEN_DEPS,
): Promise<string> {
  requireAppSecrets(env);
  const nowMs = deps.now();
  if (cachedToken && cachedToken.expiresAtMs - 60_000 > nowMs) {
    return cachedToken.token;
  }

  const jwt = await mintAppJwt(env, Math.floor(nowMs / 1000));
  const res = await deps.fetch(
    `${GITHUB_API}/app/installations/${env.GH_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lumiagents/1.0",
      },
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub App installation-token mint failed → ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  cachedToken = { token: data.token, expiresAtMs: new Date(data.expires_at).getTime() };
  return data.token;
}

// ─── ghAppFetch: mirrors githubFetch but attaches the installation token ───────────

/**
 * Fetch the GitHub API as the App installation. Mirrors integrations/github/base.ts#githubFetch
 * but uses the installation token instead of GITHUB_API_TOKEN. Throws on non-2xx.
 */
export async function ghAppFetch<T>(
  env: Env,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const token = await getInstallationToken(env);
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lumiagents/1.0",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub App API ${init?.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export type GhAppFetch = typeof ghAppFetch;
