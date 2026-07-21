/**
 * Shared entry-point factory for per-agent Cloudflare Workers.
 * Each of the six agents gets its own wrangler.toml that
 * points to a tiny wrapper in this file. The runtime gateway forwards chat
 * requests here via a Service Binding; this file runs the chat loop and returns.
 */
import { runAgentChat, type AgentChatRequest, type AgentEnv, type AgentSlug } from "../agents/agent-chat";

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Runtime-Url",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export function makeAgentWorker(slug: AgentSlug) {
  return {
    async fetch(request: Request, env: AgentEnv, _ctx: ExecutionContext): Promise<Response> {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders() });
      }

      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }

      // runtimeUrl and dispatchToken are injected by the gateway.
      const runtimeUrl = request.headers.get("X-Runtime-Url") ?? "";
      const dispatchToken = request.headers.get("X-Dispatch-Token") ?? undefined;

      let body: { messages?: unknown; files?: unknown; memoryPreamble?: unknown };
      try { body = await request.json() as typeof body; }
      catch { return json({ error: "Invalid JSON body" }, 400); }

      const chatReq: AgentChatRequest = {
        agentSlug: slug,
        messages: (body.messages ?? []) as AgentChatRequest["messages"],
      };
      const rawFiles = body.files as AgentChatRequest["files"];
      if (rawFiles?.length) chatReq.files = rawFiles;
      if (typeof body.memoryPreamble === "string") chatReq.memoryPreamble = body.memoryPreamble;

      try {
        const result = await runAgentChat(env, chatReq, runtimeUrl, dispatchToken);
        return json(result);
      } catch (err) {
        console.error(`[${slug}] chat error:`, err);
        return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
      }
    },
  };
}
