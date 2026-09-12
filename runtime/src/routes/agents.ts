import type { Env } from "../types";
import { AGENTS } from "../../../agents";
import type { AgentDefinition } from "../../../agents";
import { runAgentChat } from "../agents/agent-chat";
import type { AgentChatRequest, AgentChatResponse, AgentSlug, ChatMessage, FileAttachment } from "../agents/agent-chat";
import { resolveAgentChatConfig } from "../agents/resolve-agent-config";
import { buildConfigAgentDefinition } from "../agents/catalog-agent";
import { orchestrations } from "../registry";
import { SupabaseClient } from "../db/client";
import { resolveConversation, loadTranscript, persistTurn, recall, maybeSummarize } from "../agents/memory";
import { suggestedPromptsFor } from "../../../agents";
import { json, requireUser, rateLimited, schemaToJsonSchema } from "./helpers";

/**
 * Tier 1 (#67): if `slug` is a config agent (a catalog row with source='config' and no
 * dedicated Worker binding), assemble its AgentDefinition from the catalog + agent_tools +
 * the code orchestration registry, so it can run through the inline runAgentChat path.
 *
 * Returns:
 *   - { def }        → a runnable config agent; route inline with this definition.
 *   - { disabled }   → the config agent exists but its lifecycle is 'disabled'.
 *   - null           → not a config agent (a code agent, or unknown slug); behave as today.
 *
 * Best-effort: any lookup failure yields null, so the runtime degrades to code-agents-only
 * (no-op safety) rather than erroring on an empty/unreachable catalog.
 */
async function resolveConfigAgent(
  db: SupabaseClient,
  slug: string,
  hasWorkerBinding: boolean,
): Promise<{ def: AgentDefinition } | { disabled: true } | null> {
  const row = await db.getCatalogAgent(slug).catch(() => null);
  if (!row || row.source !== "config" || hasWorkerBinding) return null;
  if (row.lifecycle === "disabled") return { disabled: true };
  const toolRows = await db.getAgentTools(slug).catch(() => []);
  const def = buildConfigAgentDefinition(row, toolRows, (name) => {
    const orch = orchestrations.get(name);
    if (!orch) return null;
    return { description: orch.description ?? null, inputSchema: schemaToJsonSchema(orch.inputSchema) };
  });
  return { def };
}

/**
 * Mint the short-lived token an agent uses to call back into the runtime.
 *
 * `sub`/`user_role` are the authorization principal and are deliberately unchanged:
 * agent dispatch is still a trusted ops-equivalent machine caller. `act_for` (#127) is
 * ATTRIBUTION ONLY — the id of the signed-in end user whose chat message caused this
 * dispatch. routes/orchestrations.ts stamps it into `triggered_by_user_id` so the run
 * shows up for that user under enduser RLS. No route may grant access based on it.
 *
 * `agent_slug` (#177) names the agent this token was minted FOR. It is NARROWING ONLY:
 * routes/orchestrations.ts uses it to look up that agent's declared knowledge corpora and
 * clamp retrieval to them. It can never widen access — an unknown or absent slug simply
 * leaves the orchestration's own scope in place.
 *
 * It is minted here, by the runtime, from the slug being routed to. The agent Worker does
 * not hold SUPABASE_JWT_SECRET and so cannot forge or alter it, which is why the claim is
 * trustworthy and a request header would not be.
 */
async function mintDispatchToken(
  jwtSecret: string,
  actForUserId?: string,
  agentSlug?: string,
): Promise<string> {
  const enc = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const header = enc(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = enc(JSON.stringify({
    sub: "agent-dispatch",
    user_role: "ops",
    ...(actForUserId ? { act_for: actForUserId } : {}),
    ...(agentSlug ? { agent_slug: agentSlug } : {}),
    iat: now,
    exp: now + 300,
  }));
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
const AGENT_BINDINGS: Record<AgentSlug, keyof Env> = {
  angie: "ANGIE_WORKER",
  beady: "BEADY_WORKER",
  cleo: "CLEO_WORKER",
  dewey: "DEWEY_WORKER",
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

  // GET /api/agents — the agent card catalogue (code ∪ config), read via service_role so
  // any signed-in user's dashboard can render every card even though writes to the catalog
  // are ops-only (RLS). Mirrors the open GET /api/orchestrations catalogue: only non-
  // sensitive card metadata is returned. Empty list on any failure (no-op safety).
  if (pathname === "/api/agents" && request.method === "GET") {
    // Public agent-card catalogue (slug/name/emoji/category only — no persona, tools,
    // or config), mirroring the public GET /api/orchestrations. It is fetched during
    // server-component render, where the Supabase session token isn't reliably available
    // (getSession() returns null in RSC), so gating it here broke the whole Agents list.
    try {
      const rows = await new SupabaseClient(env).getCatalogAgents();
      return json(rows.map((r) => {
        // For a code agent the tools are the source of truth, so its suggestions
        // are derived rather than read from card.suggestedPrompts. That column was
        // seeded once by a migration and has been drifting behind every tool added
        // since (#165); redact_resume had no suggestion at all. A config agent has
        // no code definition, so it keeps whatever its card carries.
        const derived = suggestedPromptsFor(r.slug);
        const card = derived.length > 0
          ? { ...(r.card as Record<string, unknown> ?? {}), suggestedPrompts: derived }
          : r.card;
        return {
          slug: r.slug,
          displayName: r.display_name,
          card,
          source: r.source,
          lifecycle: r.lifecycle,
        };
      }));
    } catch (err) {
      console.error("[agents] catalogue read failed:", err);
      return json([]);
    }
  }

  // POST /api/agents/:slug/chat
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)\/chat$/);
  if (agentMatch && request.method === "POST") {
    // Agent chat is open to any authenticated user (ops + enduser).
    const authResult = await requireUser(request, env);
    if (authResult instanceof Response) return authResult;

    const rl = await rateLimited(env, authResult.userId, "agent-chat", 20);
    if (rl) return rl;

    const slug = agentMatch[1] as AgentSlug;
    const runtimeUrl = `${url.protocol}//${url.host}`;

    const bindingKey = AGENT_BINDINGS[slug] as keyof Env | undefined;
    const workerBinding = bindingKey ? (env[bindingKey] as Fetcher | undefined) : undefined;

    const db = new SupabaseClient(env);

    // Tier 1 (#67): is this a config agent (catalog data, no Worker)? If so, assemble its
    // definition now and route it through the inline chat loop below. Code agents (a real
    // binding, or an AGENTS entry in local dev) are untouched.
    const configAgent = await resolveConfigAgent(db, slug, !!workerBinding);
    if (configAgent && "disabled" in configAgent) {
      return json({ error: "This agent is currently disabled." }, 403);
    }
    const configAgentDef = configAgent?.def;

    // Guard an unknown slug: not a code agent (no binding, not in AGENTS) and not a config
    // agent → 404, rather than a 500 from the inline loop's "Unknown agent slug".
    if (!workerBinding && !configAgentDef && !Object.hasOwn(AGENTS, slug)) {
      return json({ error: `Unknown agent: ${slug}` }, 404);
    }

    // The real end user behind this chat turn. If the caller was itself an agent-dispatch
    // principal (agent → agent), carry through whoever it was already acting for rather
    // than losing attribution. Undefined for a genuine machine caller.
    const actFor = authResult.userId === "agent-dispatch" ? authResult.actFor : authResult.userId;
    const dispatchToken = await mintDispatchToken(env.SUPABASE_JWT_SECRET, actFor, slug);

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

    // Semantic recall over this user's prior conversations with this agent.
    const memoryPreamble = await recall(env, { userId: authResult.userId, agentSlug: slug, queryText: lastUser?.content ?? "" });

    // Tier 0 (#67): resolve model/max_tokens (agent_configs) + persona/tool override
    // (agent_config_overrides) here — the agent Worker has no Supabase access, so we
    // thread the result through the request, exactly like memoryPreamble. For a config
    // agent (Tier 1) this is also where its persona (stored as a 'replace' override) and
    // model are layered onto the catalog-assembled definition.
    const agentConfig = await resolveAgentChatConfig(db, slug);

    let result: AgentChatResponse | null = null;
    if (workerBinding) {
      // Production: forward to the agent's own CF Worker via Service Binding, with the
      // (possibly server-rebuilt) messages + recalled memory. Headers as before.
      const forwarded = new Request(request.url, {
        method: "POST",
        headers: {
          ...Object.fromEntries(request.headers),
          "Content-Type": "application/json",
          "X-Runtime-Url": runtimeUrl,
          "X-Dispatch-Token": dispatchToken,
        },
        body: JSON.stringify({
          messages,
          files: body.files,
          memoryPreamble: memoryPreamble || undefined,
          modelConfig: agentConfig.modelConfig,
          override: agentConfig.override,
        }),
      });
      // A newly-created agent Worker has no secrets until an operator runs
      // `wrangler secret put`, and a Service Binding to a not-yet-deployed Worker throws.
      // Treat either as "this agent is not ready yet" and degrade to the inline loop
      // rather than handing the user a hard failure. Chat is user-facing; a slower path
      // beats an outage. Logged loudly so a permanently broken worker is still visible.
      try {
        const resp = await workerBinding.fetch(forwarded);
        if (resp.ok) {
          result = await resp.json() as AgentChatResponse;
        } else {
          console.error(`[agents] ${slug} worker returned ${resp.status}; falling back to inline chat`);
        }
      } catch (err) {
        console.error(`[agents] ${slug} worker dispatch failed; falling back to inline chat:`, err);
      }
    }

    if (!result) {
      // No dedicated worker bound (local dev / config agent), or the bound worker is not
      // usable yet. Config agents (Tier 1) always land here with their catalog-assembled
      // definition; code agents run their bundled definition (agentDef undefined).
      const chatReq: AgentChatRequest = { agentSlug: slug, messages };
      if (body.files?.length) chatReq.files = body.files;
      if (memoryPreamble) chatReq.memoryPreamble = memoryPreamble;
      if (agentConfig.modelConfig) chatReq.modelConfig = agentConfig.modelConfig;
      if (agentConfig.override) chatReq.override = agentConfig.override;
      if (configAgentDef) chatReq.agentDef = configAgentDef;
      result = await runAgentChat(env, chatReq, runtimeUrl, dispatchToken);
    }

    // Persist the turn (best-effort, off the response path). This embeds it for recall,
    // then rolls up a summary + facts on a cadence.
    if (conversationId && lastUser && result.reply) {
      const cid = conversationId;
      ctx.waitUntil(
        persistTurn(env, { conversationId: cid, userId: authResult.userId, agentSlug: slug, userText: lastUser.content, assistantText: result.reply })
          .then(() => maybeSummarize(env, { conversationId: cid, userId: authResult.userId, agentSlug: slug })),
      );
    }

    return json({ ...result, conversationId });
  }

  return null;
}
