"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOps } from "@/lib/require-ops";
import { revalidatePath } from "next/cache";
import type { AgentManifestDraft, SaveResult } from "@/lib/agent-manifest";
import { fetchRuntime } from "@/lib/runtime-fetch";
import {
  validateConfigAgent,
  type ConfigAgentDraft,
  type OrchestrationInfo,
} from "../../../../runtime/src/agents/catalog-validation";

// Tier 1 agent builder (#67). All four actions are ops-gated via requireOps() (mirrors the
// Tier 0 customize actions) AND backstopped by the agents / agent_tools ops_all RLS, so a
// non-ops caller is refused even if this check were somehow bypassed. Config agents only —
// the six code agents are edited through the Phase 1 Tier 0 customize panel, never here.


function toConfigDraft(m: AgentManifestDraft): ConfigAgentDraft {
  return {
    slug: m.slug.trim(),
    displayName: m.displayName.trim(),
    card: {
      emoji: m.emoji.trim(),
      category: m.category.trim(),
      description: m.description.trim(),
      suggestedPrompts: m.suggestedPrompts.map((s) => s.trim()).filter(Boolean),
    },
    systemPrompt: m.systemPrompt,
    model: m.model,
    maxTokens: m.maxTokens,
    tools: m.tools.map((t) => ({
      orchestrationName: t.orchestrationName,
      mode: t.mode,
      params: t.params ?? null,
    })),
    knowledgeCorpora: m.knowledgeCorpora,
  };
}

/** Fetch the live orchestration catalogue (registry ∪ DB is_active) + existing config-agent
 *  slugs, the two facts validateConfigAgent needs. */
async function loadValidationContext(
  sb: Awaited<ReturnType<typeof createClient>>,
  excludeSlug: string | null,
): Promise<{ orchestrations: OrchestrationInfo[]; existingSlugs: string[] }> {
  const [catalogueRes, activeRows, agentRows] = await Promise.all([
    fetchRuntime(`/api/orchestrations`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ name: string; readOnly?: boolean }[]>) : []))
      .catch(() => [] as { name: string; readOnly?: boolean }[]),
    sb.schema("orchestration").from("orchestrations").select("name, is_active"),
    sb.schema("orchestration").from("agents").select("slug"),
  ]);

  const activeByName = new Map<string, boolean>(
    ((activeRows.data ?? []) as { name: string; is_active: boolean }[]).map((o) => [o.name, o.is_active]),
  );
  const orchestrations: OrchestrationInfo[] = catalogueRes.map((o) => ({
    name: o.name,
    isActive: activeByName.get(o.name) ?? true,
    // #127: forward the orchestration's own readOnly declaration so
    // validateConfigAgent can accept sync mode where it is genuinely legal.
    // Dropping it here made every sync mapping fail validation.
    readOnly: o.readOnly,
  }));
  const existingSlugs = ((agentRows.data ?? []) as { slug: string }[])
    .map((a) => a.slug)
    .filter((s) => s !== excludeSlug);

  return { orchestrations, existingSlugs };
}

/** Args for the save_config_agent RPC — the whole write (agents + agent_configs +
 *  agent_config_overrides + agent_tools) runs in one transaction inside the function,
 *  so a partial failure rolls back cleanly (#114). owner/created_by/updated_by are set
 *  from auth.uid() inside the RPC. */
function rpcArgs(draft: ConfigAgentDraft, isCreate: boolean) {
  return {
    p_slug: draft.slug,
    p_display_name: draft.displayName,
    p_card: draft.card,
    p_knowledge_corpora: draft.knowledgeCorpora,
    p_model: draft.model,
    p_max_tokens: draft.maxTokens,
    p_system_prompt: draft.systemPrompt,
    p_tools: draft.tools.map((t) => ({
      orchestration_name: t.orchestrationName,
      params: t.params ?? null,
      mode: t.mode,
    })),
    p_is_create: isCreate,
  };
}

/** Create a brand-new config agent (identity + card + persona + model + tools + knowledge). */
export async function createAgent(manifest: AgentManifestDraft): Promise<SaveResult> {
  await requireOps();
  const sb = await createClient();
  const draft = toConfigDraft(manifest);

  const ctx = await loadValidationContext(sb, null);
  const errors = validateConfigAgent(draft, ctx);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // One atomic write (agents + config + override + tools) — see save_config_agent (#114).
  const { error } = await sb.schema("orchestration").rpc("save_config_agent", rpcArgs(draft, true));
  if (error) return { ok: false, errors: { form: error.message } };

  revalidatePath("/agents");
  revalidatePath(`/agents/${draft.slug}`);
  return { ok: true, slug: draft.slug };
}

/** Edit a config agent (slug is immutable). Re-runs full validation, then rewrites its rows. */
export async function updateAgent(slug: string, manifest: AgentManifestDraft): Promise<SaveResult> {
  await requireOps();
  const sb = await createClient();
  const draft = toConfigDraft({ ...manifest, slug }); // slug cannot be changed on edit

  // Friendly pre-check (the RPC also enforces both, and rolls back on violation).
  const { data: existing } = await sb.schema("orchestration").from("agents")
    .select("source").eq("slug", slug).maybeSingle();
  if (!existing) return { ok: false, errors: { form: `Unknown agent: ${slug}` } };
  if ((existing as { source: string }).source !== "config") {
    return { ok: false, errors: { form: "Built-in agents are edited from their Customize panel." } };
  }

  const ctx = await loadValidationContext(sb, slug);
  const errors = validateConfigAgent(draft, ctx);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // One atomic write (agents + config + override + tools) — see save_config_agent (#114).
  const { error } = await sb.schema("orchestration").rpc("save_config_agent", rpcArgs(draft, false));
  if (error) return { ok: false, errors: { form: error.message } };

  revalidatePath("/agents");
  revalidatePath(`/agents/${slug}`);
  return { ok: true, slug };
}

/** Disable or re-enable a config agent (lifecycle). A disabled agent refuses chat at the runtime. */
export async function setAgentLifecycle(
  slug: string,
  lifecycle: "active" | "disabled",
): Promise<SaveResult> {
  await requireOps();
  const sb = await createClient();
  const { error } = await sb.schema("orchestration").from("agents")
    .update({ lifecycle, updated_at: new Date().toISOString() })
    .eq("slug", slug).eq("source", "config");
  if (error) return { ok: false, errors: { form: error.message } };
  revalidatePath("/agents");
  revalidatePath(`/agents/${slug}`);
  return { ok: true, slug };
}

/** Delete a config agent (cascades to agent_tools). Code agents are protected by the source filter. */
export async function deleteAgent(slug: string): Promise<SaveResult> {
  await requireOps();
  const sb = await createClient();
  const { error } = await sb.schema("orchestration").from("agents")
    .delete().eq("slug", slug).eq("source", "config");
  if (error) return { ok: false, errors: { form: error.message } };
  revalidatePath("/agents");
  return { ok: true, slug };
}
