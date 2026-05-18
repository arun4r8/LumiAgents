import type { Env } from "../types";
import { runAgentChat } from "../agents/agent-chat";
import { parseBotActivity, sendBotReplyWithToken } from "../../../integrations/teams/bot";
import { json } from "./helpers";

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
    const slug = agentMatch[1] as "angie" | "beady" | "patch" | "money";
    const runtimeUrl = `${url.protocol}//${url.host}`;

    const bindingKey = AGENT_BINDINGS[slug];
    const workerBinding = bindingKey ? (env[bindingKey] as Fetcher | undefined) : undefined;

    const dispatchToken = await mintDispatchToken(env.SUPABASE_JWT_SECRET);

    if (workerBinding) {
      // Production: forward to the agent's own CF Worker via Service Binding.
      // Inject X-Runtime-Url (for tool dispatch callbacks) and X-Dispatch-Token (ops JWT).
      const forwarded = new Request(request, {
        headers: {
          ...Object.fromEntries(request.headers),
          "X-Runtime-Url": runtimeUrl,
          "X-Dispatch-Token": dispatchToken,
        },
      });
      return workerBinding.fetch(forwarded);
    }

    // Development fallback: run the chat loop locally (no Service Binding configured).
    let body: { messages?: unknown; files?: unknown };
    try { body = await request.json() as typeof body; }
    catch { return json({ error: "Invalid JSON body" }, 400); }

    const chatReq: import("../agents/agent-chat").AgentChatRequest = {
      agentSlug: slug,
      messages: (body.messages ?? []) as import("../agents/agent-chat").ChatMessage[],
    };
    const rawFiles = body.files as import("../agents/agent-chat").FileAttachment[] | undefined;
    if (rawFiles?.length) chatReq.files = rawFiles;
    const result = await runAgentChat(env, chatReq, runtimeUrl, dispatchToken);

    return json(result);
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

    const chatPromise = runAgentChat(env, {
      agentSlug: slug,
      messages: [{ role: "user", content: parsed.text }],
    }, runtimeUrl).then(async (result) => {
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
    }).catch((err) => {
      console.error("[teams-bot] reply error:", err);
    });

    ctx.waitUntil(chatPromise);
    return new Response(null, { status: 200 });
  }

  return null;
}
