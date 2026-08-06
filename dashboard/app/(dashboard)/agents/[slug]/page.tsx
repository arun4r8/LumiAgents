import { notFound } from "next/navigation";
import AgentChatClient from "@/components/agent-chat-client";
import CustomizeAgentPanel from "@/components/customize-agent-panel";
import AgentComposer, { type OrchestrationOption } from "@/components/agent-composer";
import ProposeCapabilityPanel from "@/components/propose-capability-panel";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { roleOf } from "@/lib/role";
import { getAgentDef } from "@/lib/agent-defs";
import { cardFromRow, getOrchestrationOptions } from "@/lib/agent-catalog";
import { ALLOWED_MODELS, type PromptStrategy } from "@/lib/agent-overrides";
import {
  DEFAULT_MAX_TOKENS,
  type AgentManifestDraft,
} from "@/lib/agent-manifest";
import { saveAgentOverrides, revertAgentOverride } from "./actions";
import {
  proposeCapability,
  listProposals,
  cancelProposal,
  type PendingProposal,
} from "./propose-actions";
import { createAgent, updateAgent, setAgentLifecycle, deleteAgent } from "../actions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

interface OverrideRow {
  id: string;
  prompt_strategy: PromptStrategy;
  system_prompt: string | null;
  enabled_tools: string[] | null;
  created_at: string;
}

interface RawCard {
  emoji?: string;
  category?: string;
  description?: string;
  suggestedPrompts?: string[];
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

export default async function AgentDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const admin = createAdminClient();
  const { data: agentRow } = await admin
    .schema("orchestration").from("agents")
    .select("slug, display_name, card, source, lifecycle")
    .eq("slug", slug).maybeSingle();
  if (!agentRow) notFound();
  const card = cardFromRow(agentRow as Parameters<typeof cardFromRow>[0]);

  // The chat header's "N orchestrations" tag, counted exactly as the catalog card
  // counts it (see app/(dashboard)/agents/page.tsx): the agent's own `<slug>/…`
  // namespace for a code agent, its wired agent_tools rows for a config agent.
  const [nsRes, wiredRes] = await Promise.all([
    admin.schema("orchestration").from("orchestrations")
      .select("name", { count: "exact", head: true })
      .eq("is_active", true).like("name", `${slug}/%`),
    admin.schema("orchestration").from("agent_tools")
      .select("agent_slug", { count: "exact", head: true })
      .eq("agent_slug", slug),
  ]);
  const orchestrationCount = (nsRes.count ?? 0) + (wiredRes.count ?? 0);

  // One source of truth for role — see lib/role.ts.
  const isOps = roleOf(user) === "ops";

  // Ops-only authoring surfaces are prepared server-side; endusers only get the chat.
  const configEditor = isOps && card.source === "config" ? await loadConfigEditor(slug) : null;
  const codeCustomizer = isOps && card.source === "code" ? await loadCodeCustomizer(slug) : null;
  // Tier 2 (#67): the "Propose new capability" panel is ops-only AND code-agent-only. Its only
  // kind that makes sense for a config agent is "table"/"agent", while its default and headline
  // kind — "New tool" — always 400s there: validateSpec requires an agentSlug that exists in the
  // code REGISTRY (registryValidationContext derives slugs from orchestration names), and a config
  // agent has no registered orchestrations of its own. Rather than offer a button that cannot
  // work, the panel renders only for `source === "code"`.
  const showProposePanel = isOps && card.source === "code";
  // Pending proposals (orchestration.agent_proposals) — a badge, never a visibility change.
  const pendingProposals = showProposePanel ? await loadPendingProposals(slug) : [];
  // Tier 2 Build 2 (#67): existing orchestration names, for the "new agent" form's tool picker
  // (a new agent may only wire orchestrations that already exist).
  const orchestrationNames = showProposePanel ? await loadOrchestrationNames() : [];

  return (
    <>
      <AgentChatClient
        slug={card.slug}
        agentName={card.name}
        agentDomain={card.category}
        description={card.description}
        orchestrationCount={orchestrationCount}
        suggestedPrompts={card.suggestedPrompts}
      />

      {configEditor && (
        <div className="page" style={{ paddingTop: 0 }}>
          <AgentComposer
            mode="edit"
            initial={configEditor.initial}
            lifecycle={configEditor.lifecycle}
            orchestrations={configEditor.orchestrations}
            createAgent={createAgent}
            updateAgent={updateAgent}
            setAgentLifecycle={setAgentLifecycle}
            deleteAgent={deleteAgent}
          />
        </div>
      )}

      {codeCustomizer && (
        <div className="page" style={{ paddingTop: 0 }}>
          <CustomizeAgentPanel
            slug={codeCustomizer.slug}
            displayName={codeCustomizer.displayName}
            basePrompt={codeCustomizer.basePrompt}
            tools={codeCustomizer.tools}
            allowedModels={ALLOWED_MODELS}
            current={codeCustomizer.current}
            history={codeCustomizer.history}
            saveAgentOverrides={saveAgentOverrides}
            revertAgentOverride={revertAgentOverride}
          />
        </div>
      )}

      {showProposePanel && (
        <div className="page" style={{ paddingTop: 0 }}>
          <ProposeCapabilityPanel
            agentSlug={slug}
            pendingProposals={pendingProposals}
            orchestrationNames={orchestrationNames}
            proposeCapability={proposeCapability}
            listProposals={listProposals}
            cancelProposal={cancelProposal}
          />
        </div>
      )}
    </>
  );
}

// ─── Tier 2 (#67): pending proposals for this agent ──────────────────────────────
//
// Read straight from orchestration.agent_proposals. Deliberately a plain DB read with no GitHub
// round-trip: reconciling every open PR on every page render would put a third-party API on the
// critical path of an agent page. The panel offers an explicit "Check PR status" action that
// calls the runtime, which does reconcile.
//
// Note what is NOT here any more: the agent's `lifecycle`. A pending proposal used to set the
// donor agent's lifecycle to 'proposed', and the agents list hides anything non-active from
// end users — so proposing a tool for Cleo hid Cleo from everyone. A proposal is now a badge.

async function loadPendingProposals(slug: string): Promise<PendingProposal[]> {
  const supabase = await createClient();
  const { data } = await supabase.schema("orchestration").from("agent_proposals")
    .select("id, kind, agent_slug, target, pr_number, pr_url, branch, status, created_at")
    .eq("agent_slug", slug).eq("status", "open")
    .order("created_at", { ascending: false });
  return (data ?? []) as PendingProposal[];
}

// ─── Tier 2 Build 2 (#67): existing orchestration names for the new-agent tool picker ──

async function loadOrchestrationNames(): Promise<string[]> {
  const supabase = await createClient();
  const { data } = await supabase.schema("orchestration").from("orchestrations")
    .select("name, is_active").eq("is_active", true).order("name");
  return ((data ?? []) as { name: string }[]).map((o) => o.name);
}

// ─── Config agent: pre-fill the edit round-trip composer (Tier 1) ───────────────

async function loadConfigEditor(slug: string): Promise<{
  initial: AgentManifestDraft;
  lifecycle: "active" | "disabled";
  orchestrations: OrchestrationOption[];
} | null> {
  const supabase = await createClient();

  const [agentRes, toolRes, cfgRes, ovrRes, orchRes] = await Promise.all([
    supabase.schema("orchestration").from("agents")
      .select("display_name, card, knowledge_corpora, lifecycle").eq("slug", slug).maybeSingle(),
    supabase.schema("orchestration").from("agent_tools")
      .select("orchestration_name, params, mode, position").eq("agent_slug", slug).order("position"),
    supabase.schema("orchestration").from("agent_configs")
      .select("model, max_tokens").eq("agent_id", slug).maybeSingle(),
    supabase.schema("orchestration").from("agent_config_overrides")
      .select("system_prompt").eq("agent_id", slug).order("created_at", { ascending: false }).limit(1),
    supabase.schema("orchestration").from("orchestrations").select("name, is_active"),
  ]);

  const agent = agentRes.data as {
    display_name: string; card: RawCard | null;
    knowledge_corpora: string[] | null; lifecycle: "active" | "disabled";
  } | null;
  if (!agent) return null;

  const c = agent.card ?? {};
  const toolRows = (toolRes.data ?? []) as {
    orchestration_name: string; params: Record<string, unknown> | null;
    mode: "async" | "sync"; position: number | null;
  }[];
  const cfg = cfgRes.data as { model: string; max_tokens: number } | null;
  const persona = ((ovrRes.data ?? [])[0] as { system_prompt: string | null } | undefined)?.system_prompt ?? "";

  const initial: AgentManifestDraft = {
    slug,
    displayName: agent.display_name,
    emoji: c.emoji ?? "🤖",
    category: c.category ?? "",
    description: c.description ?? "",
    suggestedPrompts: Array.isArray(c.suggestedPrompts) ? c.suggestedPrompts : [],
    systemPrompt: persona,
    model: cfg?.model ?? DEFAULT_MODEL,
    maxTokens: cfg?.max_tokens ?? DEFAULT_MAX_TOKENS,
    tools: toolRows.map((t) => ({ orchestrationName: t.orchestration_name, mode: t.mode, params: t.params })),
    knowledgeCorpora: agent.knowledge_corpora ?? ["shared"],
  };

  const activeByName = new Map<string, boolean>(
    ((orchRes.data ?? []) as { name: string; is_active: boolean }[]).map((o) => [o.name, o.is_active]),
  );
  const orchestrations = await getOrchestrationOptions(activeByName);

  return { initial, lifecycle: agent.lifecycle, orchestrations };
}

// ─── Code agent: the Phase 1 Tier 0 customize panel (unchanged behavior) ────────

async function loadCodeCustomizer(slug: string) {
  const supabase = await createClient();
  const def = getAgentDef(slug);
  if (!def) return null;

  const [overridesRes, cfgRes] = await Promise.all([
    supabase.schema("orchestration").from("agent_config_overrides")
      .select("id, prompt_strategy, system_prompt, enabled_tools, created_at")
      .eq("agent_id", slug)
      .order("created_at", { ascending: false }),
    supabase.schema("orchestration").from("agent_configs")
      .select("model, max_tokens, updated_at")
      .eq("agent_id", slug)
      .maybeSingle(),
  ]);

  const history = (overridesRes.data ?? []) as OverrideRow[];
  const latest = history[0] ?? null;
  const cfg = cfgRes.data as { model: string; max_tokens: number; updated_at: string | null } | null;

  const current = {
    system_prompt: latest?.system_prompt ?? null,
    prompt_strategy: latest?.prompt_strategy ?? ("append" as PromptStrategy),
    enabled_tools: latest?.enabled_tools ?? null,
    model: cfg?.model ?? DEFAULT_MODEL,
    max_tokens: cfg?.max_tokens ?? DEFAULT_MAX_TOKENS,
    updated_at: cfg?.updated_at ?? latest?.created_at ?? null,
  };

  return {
    slug: def.slug,
    displayName: def.displayName,
    basePrompt: def.systemPrompt,
    tools: def.tools,
    current,
    history,
  };
}
