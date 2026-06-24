// Agent memory (Phase 1): durable conversations + transcripts, Teams identity.
// All helpers fail open — a memory problem must never break the chat itself.
// Runs in the runtime worker (has Supabase creds); the route orchestrates recall
// and persistence around the agent Service-Binding forward.
import type { Env } from "../types";
import type { ChatMessage } from "./agent-chat";

const sbHeaders = (env: Env, extra: Record<string, string> = {}): Record<string, string> => ({
  "Content-Type": "application/json",
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Accept-Profile": "orchestration",
  "Content-Profile": "orchestration",
  ...extra,
});

const rest = (env: Env, path: string): string => `${env.SUPABASE_URL}/rest/v1/${path}`;

// Map a Teams user id → Lumiture user_id, recording unmapped users so an admin can
// link them later. Returns null when unmapped.
export async function resolveTeamsUser(env: Env, teamsUserId: string, displayName?: string): Promise<string | null> {
  try {
    const res = await fetch(rest(env, `teams_users?teams_user_id=eq.${encodeURIComponent(teamsUserId)}&select=user_id`), { headers: sbHeaders(env) });
    if (res.ok) {
      const rows = (await res.json()) as Array<{ user_id: string | null }>;
      if (rows.length) return rows[0]!.user_id;
    }
    await fetch(rest(env, "teams_users?on_conflict=teams_user_id"), {
      method: "POST",
      headers: sbHeaders(env, { Prefer: "resolution=ignore-duplicates,return=minimal" }),
      body: JSON.stringify({ teams_user_id: teamsUserId, display_name: displayName ?? null }),
    });
  } catch (e) {
    console.warn("[memory] resolveTeamsUser failed:", e);
  }
  return null;
}

// Resolve (or create) the conversation for this turn. Returns its id, or null on failure.
export async function resolveConversation(
  env: Env,
  opts: { agentSlug: string; userId?: string | null; conversationId?: string | null; externalId?: string | null },
): Promise<string | null> {
  try {
    if (opts.conversationId) return opts.conversationId;
    if (opts.externalId) {
      const res = await fetch(
        rest(env, `conversations?agent_slug=eq.${encodeURIComponent(opts.agentSlug)}&external_id=eq.${encodeURIComponent(opts.externalId)}&select=id`),
        { headers: sbHeaders(env) },
      );
      if (res.ok) {
        const rows = (await res.json()) as Array<{ id: string }>;
        if (rows.length) return rows[0]!.id;
      }
    }
    const insert = await fetch(rest(env, "conversations"), {
      method: "POST",
      headers: sbHeaders(env, { Prefer: "return=representation" }),
      body: JSON.stringify({ agent_slug: opts.agentSlug, user_id: opts.userId ?? null, external_id: opts.externalId ?? null }),
    });
    if (insert.ok) {
      const rows = (await insert.json()) as Array<{ id: string }>;
      return rows[0]?.id ?? null;
    }
  } catch (e) {
    console.warn("[memory] resolveConversation failed:", e);
  }
  return null;
}

// Most recent turns for a conversation, oldest-first.
export async function loadTranscript(env: Env, conversationId: string, limit = 10): Promise<ChatMessage[]> {
  try {
    const res = await fetch(
      rest(env, `messages?conversation_id=eq.${conversationId}&select=role,content&order=created_at.desc&limit=${limit}`),
      { headers: sbHeaders(env) },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as ChatMessage[];
    return rows.reverse();
  } catch (e) {
    console.warn("[memory] loadTranscript failed:", e);
    return [];
  }
}

// Persist one user+assistant turn and bump the conversation timestamps.
export async function persistTurn(env: Env, opts: { conversationId: string; userText: string; assistantText: string }): Promise<void> {
  try {
    await fetch(rest(env, "messages"), {
      method: "POST",
      headers: sbHeaders(env, { Prefer: "return=minimal" }),
      body: JSON.stringify([
        { conversation_id: opts.conversationId, role: "user", content: opts.userText },
        { conversation_id: opts.conversationId, role: "assistant", content: opts.assistantText },
      ]),
    });
    const now = new Date().toISOString();
    await fetch(rest(env, `conversations?id=eq.${opts.conversationId}`), {
      method: "PATCH",
      headers: sbHeaders(env, { Prefer: "return=minimal" }),
      body: JSON.stringify({ last_message_at: now, updated_at: now }),
    });
  } catch (e) {
    console.warn("[memory] persistTurn failed:", e);
  }
}
