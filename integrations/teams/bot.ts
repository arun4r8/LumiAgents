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
 *   2a. Note the "App Tenant ID" → TEAMS_BOT_TENANT_ID. Azure deprecated
 *       MultiTenant bot creation, so the registration is SingleTenant and this
 *       is required. Without it the runtime validates against Bot Framework's
 *       issuer instead of the tenant's and rejects every activity with a 401,
 *       which looks exactly like the bot never receiving anything.
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
  const isValid = await verifyBotToken(authHeader, env.TEAMS_BOT_APP_ID ?? "", env.TEAMS_BOT_TENANT_ID);

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

// ─── File attachments ─────────────────────────────────────────────────────────

/**
 * Download files a user attached in Teams so the agent can actually read them.
 *
 * The route parsed `attachments` from the day it was written but never used
 * them, so until now uploading a resume in Teams and asking for something to be
 * done with it silently did nothing: the model only ever saw the message text.
 *
 * Teams sends an uploaded file as an attachment of type
 * `application/vnd.microsoft.teams.file.download.info`, whose content carries a
 * short-lived PRE-AUTHENTICATED `downloadUrl`. That is the whole reason this
 * needs no new Graph permissions: we are not reaching into OneDrive or
 * SharePoint, we are following a URL Teams already handed us for this message.
 * Do not "improve" this by swapping in a Graph call.
 *
 * Anything that is not a real uploaded file (inline images, HTML previews,
 * Adaptive Cards the bot itself sent) is skipped rather than guessed at.
 */

/** Teams' wrapper type for an uploaded file. */
const TEAMS_FILE_TYPE = "application/vnd.microsoft.teams.file.download.info";

/** Extensions we can hand to the agent, mapped to the mime type it expects. */
const DOWNLOADABLE: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

/** Text formats are passed through as text; everything else as base64. */
function isTextual(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json";
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  // Chunked so a large resume cannot blow the argument limit of String.fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export interface DownloadedFile {
  name: string;
  mimeType: string;
  /** Text for textual formats, base64 otherwise, matching FileAttachment. */
  content: string;
}

export interface TeamsDownloadResult {
  files: DownloadedFile[];
  /** Names that were attached but could not be used, with the reason. */
  skipped: string[];
}

/** Refuse anything implausible for a document, so a bad link cannot exhaust the Worker. */
const MAX_BYTES = 12 * 1024 * 1024;

export async function downloadTeamsFiles(
  attachments: BotAttachment[],
  fetchImpl: typeof fetch = fetch,
): Promise<TeamsDownloadResult> {
  const files: DownloadedFile[] = [];
  const skipped: string[] = [];

  for (const att of attachments) {
    if (att.contentType !== TEAMS_FILE_TYPE) continue;

    const name = att.name ?? "attachment";
    const info = att.content as { downloadUrl?: unknown } | undefined;
    const downloadUrl = typeof info?.downloadUrl === "string" ? info.downloadUrl : null;
    if (!downloadUrl) {
      skipped.push(`${name} (no download link)`);
      continue;
    }

    const ext = extensionOf(name);
    const mimeType = DOWNLOADABLE[ext];
    if (!mimeType) {
      skipped.push(`${name} (unsupported type)`);
      continue;
    }

    try {
      const res = await fetchImpl(downloadUrl);
      if (!res.ok) {
        skipped.push(`${name} (download failed, ${res.status})`);
        continue;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) {
        skipped.push(`${name} (too large)`);
        continue;
      }
      files.push({
        name,
        mimeType,
        content: isTextual(mimeType) ? new TextDecoder().decode(buf) : toBase64(buf),
      });
    } catch {
      skipped.push(`${name} (download failed)`);
    }
  }

  return { files, skipped };
}
