"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOps } from "@/lib/require-ops";
import { revalidatePath } from "next/cache";
import type { AgentManifestDraft, SaveResult } from "@/lib/agent-manifest";
import {
  validateConfigAgent,
  type ConfigAgentDraft,
  type OrchestrationInfo,
} from "../../../../runtime/src/agents/catalog-validation";

// Tier 1 agent builder (#67). All four actions are ops-gated via requireOps() (mirrors the
// Tier 0 customize actions) AND backstopped by the agents / agent_tools ops_all RLS, so a
// non-ops caller is refused even if this check were somehow bypassed. Config agents only —
// the six code agents are edited through the Phase 1 Tier 0 customize panel, never here.

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

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
    fetch(`${RUNTIME}/api/orchestrations`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ name: string }[]>) : []))
      .catch(() => [] as { name: string }[]),
    sb.schema("orchestration").from("orchestrations").select("name, is_active"),
    sb.schema("orchestration").from("agents").select("slug"),
  ]);

  const activeByName = new Map<string, boolean>(
    ((activeRows.data ?? []) as { name: string; is_active: boolean }[]).map((o) => [o.name, o.is_active]),
  );
  const orchestrations: OrchestrationInfo[] = catalogueRes.map((o) => ({
    name: o.name,
    isActive: activeByName.get(o.name) ?? true,
  }));
  const existingSlugs = ((agentRows.data ?? []) as { slug: string }[])
    .map((a) => a.slug)
    .filter((s) => s !== excludeSlug);

  return { orchestrations, existingSlugs };
}

/** Persist the config-agent rows (persona → agent_config_overrides 'replace'; model →
 *  agent_configs; tools → agent_tools). Reused by create + update. */
async function writeAgentData(
  sb: Awaited<ReturnType<typeof createClient>>,
  draft: ConfigAgentDraft,
  userId: string,
): Promise<string | null> {
  // Model / max_tokens (reuses the Tier 0 config table).
  const { error: cfgErr } = await sb.schema("orchestration").from("agent_configs").upsert({
    agent_id: draft.slug,
    model: draft.model,
    max_tokens: draft.maxTokens,
    updated_at: new Date().toISOString(),
    updated_by: userId,
  });
  if (cfgErr) return cfgErr.message;

  // Persona: a 'replace' override so the catalog agent's empty base is replaced wholesale.
  const { error: ovrErr } = await sb.schema("orchestration").from("agent_config_overrides").insert({
    agent_id: draft.slug,
    system_prompt: draft.systemPrompt.trim(),
    prompt_strategy: "replace",
    enabled_tools: null,
    updated_by: userId,
  });
  if (ovrErr) return ovrErr.message;

  // Tools: replace the whole set (delete + insert) so an edit is idempotent.
  const { error: delErr } = await sb.schema("orchestration").from("agent_tools")
    .delete().eq("agent_slug", draft.slug);
  if (delErr) return delErr.message;

  if (draft.tools.length > 0) {
    const { error: toolsErr } = await sb.schema("orchestration").from("agent_tools").insert(
      draft.tools.map((t, i) => ({
        agent_slug: draft.slug,
        orchestration_name: t.orchestrationName,
        params: t.params ?? null,
        mode: t.mode,
        position: i,
      })),
    );
    if (toolsErr) return toolsErr.message;
  }
  return null;
}

/** Create a brand-new config agent (identity + card + persona + model + tools + knowledge). */
export async function createAgent(manifest: AgentManifestDraft): Promise<SaveResult> {
  const user = await requireOps();
  const sb = await createClient();
  const draft = toConfigDraft(manifest);

  const ctx = await loadValidationContext(sb, null);
  const errors = validateConfigAgent(draft, ctx);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // Anchor row first. If any dependent write fails we compensate by deleting it, so a failed
  // create never leaves a half-built agent (PostgREST has no cross-table transaction; the
  // validation-first + compensating-delete gives practical atomicity).
  const { error: agentErr } = await sb.schema("orchestration").from("agents").insert({
    slug: draft.slug,
    display_name: draft.displayName,
    card: draft.card,
    source: "config",
    lifecycle: "active",
    knowledge_corpora: draft.knowledgeCorpora,
    owner: user.id,
    created_by: user.id,
  });
  if (agentErr) return { ok: false, errors: { form: agentErr.message } };

  const writeErr = await writeAgentData(sb, draft, user.id);
  if (writeErr) {
    await sb.schema("orchestration").from("agents").delete().eq("slug", draft.slug);
    return { ok: false, errors: { form: writeErr } };
  }

  revalidatePath("/agents");
  revalidatePath(`/agents/${draft.slug}`);
  return { ok: true, slug: draft.slug };
}

/** Edit a config agent (slug is immutable). Re-runs full validation, then rewrites its rows. */
export async function updateAgent(slug: string, manifest: AgentManifestDraft): Promise<SaveResult> {
  const user = await requireOps();
  const sb = await createClient();
  const draft = toConfigDraft({ ...manifest, slug }); // slug cannot be changed on edit

  // Refuse to edit a code agent through this path (belt-and-suspenders; the UI never offers it).
  const { data: existing } = await sb.schema("orchestration").from("agents")
    .select("source").eq("slug", slug).maybeSingle();
  if (!existing) return { ok: false, errors: { form: `Unknown agent: ${slug}` } };
  if ((existing as { source: string }).source !== "config") {
    return { ok: false, errors: { form: "Built-in agents are edited from their Customize panel." } };
  }

  const ctx = await loadValidationContext(sb, slug);
  const errors = validateConfigAgent(draft, ctx);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const { error: agentErr } = await sb.schema("orchestration").from("agents").update({
    display_name: draft.displayName,
    card: draft.card,
    knowledge_corpora: draft.knowledgeCorpora,
    updated_at: new Date().toISOString(),
  }).eq("slug", slug);
  if (agentErr) return { ok: false, errors: { form: agentErr.message } };

  const writeErr = await writeAgentData(sb, draft, user.id);
  if (writeErr) return { ok: false, errors: { form: writeErr } };

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
