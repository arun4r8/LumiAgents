/**
 * Microsoft Teams integration: shared helpers.
 *
 * Two modes:
 *   1. Incoming Webhook:   one-way notifications; just needs TEAMS_INCOMING_WEBHOOK_URL
 *   2. Bot Framework:      bidirectional chat; needs TEAMS_BOT_APP_ID + TEAMS_BOT_APP_SECRET
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
  /**
   * Directory (tenant) GUID. Required when the bot registration is SingleTenant.
   *
   * Azure deprecated MultiTenant bot creation, so every new registration is
   * SingleTenant. Absent, the legacy multi-tenant flow is used, which still works
   * for registrations made before the deprecation.
   *
   * The difference is not cosmetic. A SingleTenant bot takes its token from the
   * tenant authority, and its inbound activities are signed by the tenant rather
   * than by Bot Framework. Validate one against the other and every request 401s,
   * which is indistinguishable from the bot being offline.
   */
  TEAMS_BOT_TENANT_ID?: string;
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

  // SingleTenant bots mint against their own tenant authority; multi-tenant ones
  // against the shared botframework.com authority.
  const authority = env.TEAMS_BOT_TENANT_ID ?? "botframework.com";
  const resp = await fetch(
    `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`,
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
let jwksCache: { url: string; keys: JsonWebKey[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

const BOT_FRAMEWORK_OIDC =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";

/** Issuers that sign a multi-tenant bot's inbound activities. */
const BOT_FRAMEWORK_ISSUERS = [
  "https://api.botframework.com",
  "https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/",
];

/**
 * Where the signing keys live, and who is allowed to have issued the token.
 *
 * These two move together. Accepting a Bot Framework issuer while fetching
 * tenant keys (or the reverse) is the whole bug this fixes, so they are returned
 * as one value rather than read from two places.
 */
export function trustFor(tenantId?: string): { oidc: string; issuers: Set<string> } {
  if (!tenantId) {
    return { oidc: BOT_FRAMEWORK_OIDC, issuers: new Set(BOT_FRAMEWORK_ISSUERS) };
  }
  return {
    oidc: `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`,
    // v2 tokens carry the /v2.0 issuer, v1 the sts.windows.net form. Accept both
    // rather than guess which the Connector sends.
    issuers: new Set([
      `https://login.microsoftonline.com/${tenantId}/v2.0`,
      `https://sts.windows.net/${tenantId}/`,
    ]),
  };
}

async function fetchJwks(oidcUrl: string): Promise<JsonWebKey[]> {
  // Keyed by URL: one shared cache would serve tenant keys for a Bot Framework
  // lookup, or the reverse, if both ever ran in the same isolate.
  if (jwksCache && jwksCache.url === oidcUrl && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const oidcResp = await fetch(oidcUrl);
  if (!oidcResp.ok) throw new Error(`OIDC config fetch failed: ${oidcResp.status}`);
  const oidc = (await oidcResp.json()) as { jwks_uri: string };
  const jwksResp = await fetch(oidc.jwks_uri);
  if (!jwksResp.ok) throw new Error(`JWKS fetch failed: ${jwksResp.status}`);
  const jwks = (await jwksResp.json()) as { keys: (JsonWebKey & { kid?: string })[] };
  jwksCache = { url: oidcUrl, keys: jwks.keys, fetchedAt: Date.now() };
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
  tenantId?: string,
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
  const trust = trustFor(tenantId);
  if (!payload.iss || !trust.issuers.has(payload.iss)) return false;

  try {
    const keys = await fetchJwks(trust.oidc);
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
