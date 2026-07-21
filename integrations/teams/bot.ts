/**
 * Teams Bot Framework: receive and reply to messages.
 *
 * When a user @mentions the bot in Teams, Microsoft posts an Activity to
 * POST /api/teams/bot in the Worker. This module handles:
 *   1. Verifying the incoming request (JWT Bearer)
 *   2. Parsing the Activity into a usable shape
 *   3. Sending a reply back via the Bot Connector service
 *
 * Azure Bot setup:
 *   1. Go to portal.azure.com → Azure Bot resource (or Bot Channels Registration)
 *   2. Note the "Microsoft App ID" → TEAMS_BOT_APP_ID
 *   3. Under "Configuration" → manage → New client secret → TEAMS_BOT_APP_SECRET
 *   4. Set messaging endpoint to: https://lumiagents-runtime.<account>.workers.dev/api/teams/bot
 *   5. Add "Microsoft Teams" channel in the bot resource
 */

import { verifyBotToken, getBotToken } from "./base";
import type { TeamsEnv } from "./base";

// ─── Activity types ───────────────────────────────────────────────────────────

export interface BotActivity {
  type: string;
  id: string;
  timestamp?: string;
  serviceUrl: string;
  channelId: string;
  conversation: { id: string; isGroup?: boolean; name?: string };
  from: { id: string; name?: string };
  recipient: { id: string; name?: string };
  text?: string;
  /** Attachments (files, images, etc.) */
  attachments?: BotAttachment[];
  /** @mention entities */
  entities?: { type: string; mentioned?: { id: string; name?: string } }[];
  value?: unknown; // Adaptive Card submit payloads
}

export interface BotAttachment {
  contentType: string;
  contentUrl?: string;
  name?: string;
  content?: unknown;
}

export interface ParsedBotMessage {
  valid: boolean;
  activity: BotActivity | null;
  /** Message text with bot @mention stripped. */
  text: string;
  /** Who sent it. */
  from: { id: string; name: string };
  /** Conversation ID needed to send replies. */
  conversationId: string;
  serviceUrl: string;
  /** Which agent this message was routed to (derived from channel name or message prefix). */
  agentSlug: string | null;
  /** Any file attachments. */
  attachments: BotAttachment[];
}

// ─── Agent routing ────────────────────────────────────────────────────────────
// Map channel names / message prefixes to agent slugs.
// Users can also say "@LumiBot angie: screen this resume" to route explicitly.

const AGENT_KEYWORDS: [RegExp, string][] = [
  [/\bangie\b/i, "angie"],
  [/\bbeady\b/i, "beady"],
  [/\bpatch\b/i, "patch"],
  [/\bmoney\b/i, "money"],
  [/\bfinance\b|financ/i, "money"],
  [/\bhr\b|\bhiring\b|\brecruit/i, "angie"],
  [/\bgovcon\b|\bopportunity\b|\bsamgov\b/i, "beady"],
  [/\bticket\b|\bjira\b|\bits\b|\bops\b/i, "patch"],
];

function detectAgent(text: string, channelName?: string): string | null {
  const hay = `${channelName ?? ""} ${text}`.toLowerCase();
  for (const [re, slug] of AGENT_KEYWORDS) {
    if (re.test(hay)) return slug;
  }
  return "patch"; // default to Patch (general ops) when ambiguous
}

// ─── Parse incoming Activity ──────────────────────────────────────────────────

export async function parseBotActivity(
  request: Request,
  env: TeamsEnv,
): Promise<ParsedBotMessage> {
  const authHeader = request.headers.get("Authorization");
  const isValid = await verifyBotToken(authHeader, env.TEAMS_BOT_APP_ID ?? "");

  if (!isValid) {
    return {
      valid: false, activity: null, text: "", conversationId: "",
      serviceUrl: "", agentSlug: null, attachments: [],
      from: { id: "", name: "" },
    };
  }

  let activity: BotActivity;
  try {
    activity = (await request.json()) as BotActivity;
  } catch {
    return {
      valid: false, activity: null, text: "", conversationId: "",
      serviceUrl: "", agentSlug: null, attachments: [],
      from: { id: "", name: "" },
    };
  }

  // Strip @mention so the agent sees clean text
  const rawText = activity.text ?? "";
  const cleanText = rawText
    .replace(/<at>[^<]+<\/at>/gi, "") // strip Teams @mention XML tags
    .replace(/^[\s:]+/, "")
    .trim();

  const agentSlug = detectAgent(cleanText, activity.conversation.name);

  return {
    valid: true,
    activity,
    text: cleanText,
    from: { id: activity.from.id, name: activity.from.name ?? "User" },
    conversationId: activity.conversation.id,
    serviceUrl: activity.serviceUrl,
    agentSlug,
    attachments: activity.attachments ?? [],
  };
}

// ─── Send reply ───────────────────────────────────────────────────────────────

export async function sendBotReply(
  serviceUrl: string,
  conversationId: string,
  replyToId: string,
  token: string,
  text: string,
): Promise<void> {
  const url = `${serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(replyToId)}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      type: "message",
      text,
      replyToId,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Bot reply failed: ${resp.status} ${body}`);
  }
}

export async function sendBotReplyWithToken(
  env: TeamsEnv,
  serviceUrl: string,
  conversationId: string,
  replyToId: string,
  text: string,
): Promise<void> {
  const token = await getBotToken(env);
  await sendBotReply(serviceUrl, conversationId, replyToId, token, text);
}
