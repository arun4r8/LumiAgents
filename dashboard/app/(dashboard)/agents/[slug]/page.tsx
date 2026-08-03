import { notFound } from "next/navigation";
import { AGENTS } from "../page";
import AgentChatClient from "@/components/agent-chat-client";
import CustomizeAgentPanel from "@/components/customize-agent-panel";
import { createClient } from "@/lib/supabase/server";
import { getAgentDef } from "@/lib/agent-defs";
import { ALLOWED_MODELS, type PromptStrategy } from "@/lib/agent-overrides";
import { saveAgentOverrides, revertAgentOverride } from "./actions";

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

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 2048; // matches the chat loop's hardcoded fallback

export default async function AgentDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const agent = AGENTS.find((a) => a.slug === slug);
  if (!agent) notFound();

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const isOps = user?.app_metadata?.role === "ops";

  // The customize panel is ops-only: only ops can read the overrides (RLS ops_all) and
  // only ops see the affordance. Everything below is skipped for endusers.
  const def = isOps ? getAgentDef(slug) : null;
  let history: OverrideRow[] = [];
  let current: {
    system_prompt: string | null;
    prompt_strategy: PromptStrategy;
    enabled_tools: string[] | null;
    model: string;
    max_tokens: number;
    updated_at: string | null;
  } | null = null;

  if (isOps && def) {
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

    history = (overridesRes.data ?? []) as OverrideRow[];
    const latest = history[0] ?? null;
    const cfg = cfgRes.data as { model: string; max_tokens: number; updated_at: string | null } | null;

    current = {
      system_prompt: latest?.system_prompt ?? null,
      prompt_strategy: latest?.prompt_strategy ?? "append",
      enabled_tools: latest?.enabled_tools ?? null,
      model: cfg?.model ?? DEFAULT_MODEL,
      max_tokens: cfg?.max_tokens ?? DEFAULT_MAX_TOKENS,
      updated_at: cfg?.updated_at ?? latest?.created_at ?? null,
    };
  }

  return (
    <>
      <AgentChatClient
        slug={agent.slug}
        agentName={agent.name}
        agentEmoji={agent.emoji}
        description={agent.description}
        suggestedPrompts={agent.suggestedPrompts}
      />

      {isOps && def && current && (
        <div className="page" style={{ paddingTop: 0 }}>
          <CustomizeAgentPanel
            slug={def.slug}
            displayName={def.displayName}
            basePrompt={def.systemPrompt}
            tools={def.tools}
            allowedModels={ALLOWED_MODELS}
            current={current}
            history={history}
            saveAgentOverrides={saveAgentOverrides}
            revertAgentOverride={revertAgentOverride}
          />
        </div>
      )}
    </>
  );
}

export function generateStaticParams() {
  return AGENTS.map((a) => ({ slug: a.slug }));
}
