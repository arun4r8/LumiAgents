/**
 * Teams Incoming Webhook — one-way notifications.
 *
 * Replaces the n8n `teams-message` and `teams-card` webhooks.
 * Get the URL from Teams: channel settings → Connectors → Incoming Webhook.
 *
 * Supports:
 *   - Plain text messages (MessageCard format)
 *   - Adaptive Cards (richer UI with action buttons)
 */

import type { TeamsEnv } from "./base";
import { assertIncomingWebhookConfigured } from "./base";
import { buildAdaptiveCard, type CardAction } from "./cards";

// ─── Plain text message ───────────────────────────────────────────────────────

export interface SendMessageOptions {
  text: string;
  title?: string;
  /** If omitted, posts to the channel configured in the webhook URL. */
  webhookUrl?: string;
}

export async function sendIncomingWebhookMessage(
  env: TeamsEnv,
  options: SendMessageOptions,
): Promise<void> {
  const url = options.webhookUrl ?? env.TEAMS_INCOMING_WEBHOOK_URL;
  if (!url) assertIncomingWebhookConfigured(env);

  const payload = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: "0076D7",
    summary: options.title ?? options.text.slice(0, 80),
    sections: [
      {
        activityTitle: options.title ?? undefined,
        activityText: options.text,
      },
    ],
  };

  const resp = await fetch(url!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Teams Incoming Webhook failed: ${resp.status} ${body}`);
  }
}

// ─── Adaptive Card ────────────────────────────────────────────────────────────

export interface SendCardOptions {
  title: string;
  body: string;
  actions?: CardAction[];
  /** If omitted, posts to the channel configured in the webhook URL. */
  webhookUrl?: string;
}

export async function sendIncomingWebhookCard(
  env: TeamsEnv,
  options: SendCardOptions,
): Promise<void> {
  const url = options.webhookUrl ?? env.TEAMS_INCOMING_WEBHOOK_URL;
  if (!url) assertIncomingWebhookConfigured(env);

  // Office 365 Connector cards don't natively support Adaptive Cards,
  // so we wrap the Adaptive Card in a messageCard attachment.
  const payload = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: buildAdaptiveCard(options.title, options.body, options.actions),
      },
    ],
  };

  const resp = await fetch(url!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Teams Incoming Webhook (card) failed: ${resp.status} ${body}`);
  }
}
