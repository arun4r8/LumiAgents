import type { Env } from "../types";
import { runAgentChat } from "../agents/agent-chat";
import { parseBotActivity, sendBotReplyWithToken } from "../../../integrations/teams/bot";
import { json } from "./helpers";

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

    if (workerBinding) {
      // Production: forward to the agent's own CF Worker via Service Binding.
      // Pass runtimeUrl so the agent worker can call back for orchestration dispatch.
      const forwarded = new Request(request, {
        headers: { ...Object.fromEntries(request.headers), "X-Runtime-Url": runtimeUrl },
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
    const result = await runAgentChat(env, chatReq, runtimeUrl);

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
