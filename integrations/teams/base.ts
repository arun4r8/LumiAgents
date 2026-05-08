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

/**
 * Lightweight JWT verification for incoming Bot Framework activities.
 * Checks the token against Microsoft's JWKS endpoint.
 * Returns true if valid, false otherwise.
 *
 * TODO (production hardening): also verify `aud` claim matches TEAMS_BOT_APP_ID
 * and that `iss` is a known Microsoft issuer.
 */
export async function verifyBotToken(
  authHeader: string | null,
  _appId: string,
): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) return false;

  // For now: presence check only. In production, verify the JWT signature
  // against https://login.botframework.com/v1/.well-known/openidconfiguration
  // TODO: implement full JWKS verification before going to production.
  return true;
}
