/**
 * Microsoft Teams integration — shared helpers.
 *
 * Two modes:
 *   1. Incoming Webhook  — one-way notifications; just needs TEAMS_INCOMING_WEBHOOK_URL
 *   2. Bot Framework     — bidirectional chat; needs TEAMS_BOT_APP_ID + TEAMS_BOT_APP_SECRET
 *
 * Set secrets via `wrangler secret put`:
 *   TEAMS_INCOMING_WEBHOOK_URL   (per-channel webhook URL from Teams connector config)
 *   TEAMS_BOT_APP_ID             (Azure Bot registration App ID)
 *   TEAMS_BOT_APP_SECRET         (Azure Bot registration client secret)
 */

export interface TeamsEnv {
  /** Teams Incoming Webhook URL for outgoing notifications (optional). */
  TEAMS_INCOMING_WEBHOOK_URL?: string;
  /** Azure Bot App ID (from Bot Framework registration). */
  TEAMS_BOT_APP_ID?: string;
  /** Azure Bot App Secret (from Bot Framework registration). */
  TEAMS_BOT_APP_SECRET?: string;
}

export function assertIncomingWebhookConfigured(env: TeamsEnv): void {
  if (!env.TEAMS_INCOMING_WEBHOOK_URL) {
    throw new Error(
      "Teams Incoming Webhook not configured. " +
        "Run: wrangler secret put TEAMS_INCOMING_WEBHOOK_URL",
    );
  }
}

export function assertBotConfigured(env: TeamsEnv): void {
  if (!env.TEAMS_BOT_APP_ID || !env.TEAMS_BOT_APP_SECRET) {
    throw new Error(
      "Teams Bot not configured. " +
        "Run: wrangler secret put TEAMS_BOT_APP_ID && wrangler secret put TEAMS_BOT_APP_SECRET",
    );
  }
}

/**
 * Acquire a Bot Framework bearer token from Azure AD.
 * Used when sending proactive messages or replies via the Bot Connector service.
 */
export async function getBotToken(env: TeamsEnv): Promise<string> {
  assertBotConfigured(env);

  const resp = await fetch(
    "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.TEAMS_BOT_APP_ID!,
        client_secret: env.TEAMS_BOT_APP_SECRET!,
        scope: "https://api.botframework.com/.default",
      }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to acquire Bot token: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as { access_token: string };
  return data.access_token;
}

// Module-level JWKS cache: { keys, fetchedAt }. Workers isolates are short-lived
// so this mainly avoids redundant fetches within a single invocation burst.
let jwksCache: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

const BOT_FRAMEWORK_OIDC =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
const KNOWN_ISSUERS = new Set([
  "https://api.botframework.com",
  "https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/",
]);

async function fetchJwks(): Promise<JsonWebKey[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const oidcResp = await fetch(BOT_FRAMEWORK_OIDC);
  if (!oidcResp.ok) throw new Error(`OIDC config fetch failed: ${oidcResp.status}`);
  const oidc = (await oidcResp.json()) as { jwks_uri: string };
  const jwksResp = await fetch(oidc.jwks_uri);
  if (!jwksResp.ok) throw new Error(`JWKS fetch failed: ${jwksResp.status}`);
  const jwks = (await jwksResp.json()) as { keys: (JsonWebKey & { kid?: string })[] };
  jwksCache = { keys: jwks.keys, fetchedAt: Date.now() };
  return jwks.keys;
}

function base64UrlToBytes(b64: string): Uint8Array {
  const padded = b64.padEnd(b64.length + (4 - (b64.length % 4)) % 4, "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Verify an incoming Bot Framework activity token against Microsoft's JWKS.
 * Validates: RS256 signature, expiry, aud (must match appId), and iss (known Microsoft issuer).
 */
export async function verifyBotToken(
  authHeader: string | null,
  appId: string,
): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  let header: { kid?: string; alg?: string };
  let payload: { aud?: string; iss?: string; exp?: number; nbf?: number };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0]!)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1]!)));
  } catch {
    return false;
  }

  if (!header.kid) return false;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) return false;
  if (typeof payload.nbf === "number" && payload.nbf > now + 300) return false;
  if (payload.aud !== appId) return false;
  if (!payload.iss || !KNOWN_ISSUERS.has(payload.iss)) return false;

  try {
    const keys = await fetchJwks();
    const jwk = (keys as (JsonWebKey & { kid?: string })[]).find((k) => k.kid === header.kid);
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return false;
  }
}
