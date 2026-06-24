import type { Env } from "../types";
import { runAgentChat } from "../agents/agent-chat";
import type { AgentChatRequest, AgentChatResponse, ChatMessage, FileAttachment } from "../agents/agent-chat";
import { resolveConversation, loadTranscript, persistTurn, resolveTeamsUser } from "../agents/memory";
import { parseBotActivity, sendBotReplyWithToken } from "../../../integrations/teams/bot";
import { json, requireOpsToken, rateLimited } from "./helpers";

async function mintDispatchToken(jwtSecret: string): Promise<string> {
  const enc = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const header = enc(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = enc(JSON.stringify({ sub: "agent-dispatch", user_role: "ops", iat: now, exp: now + 300 }));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(jwtSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `${header}.${payload}.${sig}`;
}

// Maps agent slug → which Env key holds its Service Binding.
const AGENT_BINDINGS: Record<string, keyof Env> = {
  angie: "ANGIE_WORKER",
  beady: "BEADY_WORKER",
  patch: "PATCH_WORKER",
  money: "MONEY_WORKER",
};

export async function handleAgents(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;

  // POST /api/agents/:slug/chat
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)\/chat$/);
  if (agentMatch && request.method === "POST") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const rl = await rateLimited(env, authResult.userId, "agent-chat", 20);
    if (rl) return rl;

    const slug = agentMatch[1] as "angie" | "beady" | "patch" | "money";
    const runtimeUrl = `${url.protocol}//${url.host}`;

    const bindingKey = AGENT_BINDINGS[slug];
    const workerBinding = bindingKey ? (env[bindingKey] as Fetcher | undefined) : undefined;

    const dispatchToken = await mintDispatchToken(env.SUPABASE_JWT_SECRET);

    let body: { messages?: ChatMessage[]; files?: FileAttachment[]; conversationId?: string };
    try { body = await request.json() as typeof body; }
    catch { return json({ error: "Invalid JSON body" }, 400); }

    const clientMessages = (body.messages ?? []) as ChatMessage[];

    // Resolve (or open) the durable conversation for this user+agent.
    const conversationId = await resolveConversation(env, {
      agentSlug: slug,
      userId: authResult.userId,
      conversationId: body.conversationId ?? null,
    });

    // Server-authoritative transcript once the client tracks a conversationId; until
    // then fall back to the client-supplied history (backward compatible).
    let messages = clientMessages;
    if (conversationId && body.conversationId) {
      const transcript = await loadTranscript(env, conversationId, 10);
      const latest = clientMessages[clientMessages.length - 1];
      messages = latest ? [...transcript, latest] : transcript;
    }
    const lastUser = [...clientMessages].reverse().find((m) => m.role === "user");

    let result: AgentChatResponse;
    if (workerBinding) {
      // Production: forward to the agent's own CF Worker via Service Binding, with the
      // (possibly server-rebuilt) messages. X-Runtime-Url + X-Dispatch-Token as before.
      const forwarded = new Request(request.url, {
        method: "POST",
        headers: {
          ...Object.fromEntries(request.headers),
          "Content-Type": "application/json",
          "X-Runtime-Url": runtimeUrl,
          "X-Dispatch-Token": dispatchToken,
        },
        body: JSON.stringify({ messages, files: body.files }),
      });
      const resp = await workerBinding.fetch(forwarded);
      if (!resp.ok) return resp;
      result = await resp.json() as AgentChatResponse;
    } else {
      // Development fallback: run the chat loop locally.
      const chatReq: AgentChatRequest = { agentSlug: slug, messages };
      if (body.files?.length) chatReq.files = body.files;
      result = await runAgentChat(env, chatReq, runtimeUrl, dispatchToken);
    }

    // Persist the turn (best-effort, off the response path).
    if (conversationId && lastUser && result.reply) {
      ctx.waitUntil(persistTurn(env, { conversationId, userText: lastUser.content, assistantText: result.reply }));
    }

    return json({ ...result, conversationId });
  }

  // POST /api/teams/bot
  if (pathname === "/api/teams/bot" && request.method === "POST") {
    const parsed = await parseBotActivity(request, env);

    if (!parsed.valid || !parsed.activity) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (parsed.activity.type !== "message" || !parsed.text) {
      return new Response(null, { status: 200 });
    }

    const slug = (parsed.agentSlug ?? "patch") as "angie" | "beady" | "patch" | "money";
    const runtimeUrl = `${url.protocol}//${url.host}`;

    const chatPromise = (async () => {
      // Map the Teams user → Lumiture user, and attach this thread's durable memory.
      const userId = await resolveTeamsUser(env, parsed.from.id, parsed.from.name);
      const conversationId = await resolveConversation(env, {
        agentSlug: slug,
        userId,
        externalId: parsed.conversationId,
      });
      const transcript = conversationId ? await loadTranscript(env, conversationId, 10) : [];
      const messages: ChatMessage[] = [...transcript, { role: "user", content: parsed.text }];

      const result = await runAgentChat(env, { agentSlug: slug, messages }, runtimeUrl);
      const replyText = result.runIds.length > 0
        ? `${result.reply}\n\n*Run IDs: ${result.runIds.join(", ")}*`
        : result.reply;
      await sendBotReplyWithToken(
        env,
        parsed.serviceUrl,
        parsed.conversationId,
        parsed.activity!.id,
        replyText,
      );
      if (conversationId && result.reply) {
        await persistTurn(env, { conversationId, userText: parsed.text, assistantText: result.reply });
      }
    })().catch((err) => {
      console.error("[teams-bot] reply error:", err);
    });

    ctx.waitUntil(chatPromise);
    return new Response(null, { status: 200 });
  }

  return null;
}
