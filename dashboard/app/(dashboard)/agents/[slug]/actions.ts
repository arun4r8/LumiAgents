"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOps } from "@/lib/require-ops";
import { getAgentDef } from "@/lib/agent-defs";
import { validateOverride, type OverrideDraft, type SaveResult } from "@/lib/agent-overrides";
import { revalidatePath } from "next/cache";

// Tier 0 agent customization (#67). Both actions are ops-gated via requireOps() (mirrors
// the settings ops checks) AND backstopped by the agent_config_overrides / agent_configs
// ops_all RLS policies, so a non-ops caller is refused even if this check were bypassed.

/**
 * Persist a persona/model/tools customization for an agent:
 *   - appends a new versioned row to agent_config_overrides (persona + enabled tools);
 *   - upserts model / max_tokens into agent_configs (reused, not duplicated).
 * Takes effect on the agent's next chat turn. Returns per-field errors on invalid input.
 */
export async function saveAgentOverrides(slug: string, draft: OverrideDraft): Promise<SaveResult> {
  const user = await requireOps();

  const def = getAgentDef(slug);
  if (!def) return { ok: false, errors: { form: `Unknown agent: ${slug}` } };

  const errors = validateOverride(draft, def.tools.map((t) => t.name));
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const sb = await createClient();
  const promptTrimmed = (draft.system_prompt ?? "").trim();

  const { error: ovrErr } = await sb.schema("orchestration").from("agent_config_overrides").insert({
    agent_id: slug,
    system_prompt: promptTrimmed || null,
    prompt_strategy: draft.prompt_strategy,
    enabled_tools: draft.enabled_tools, // null = all of the agent's tools
    updated_by: user.id,
  });
  if (ovrErr) return { ok: false, errors: { form: ovrErr.message } };

  const { error: cfgErr } = await sb.schema("orchestration").from("agent_configs").upsert({
    agent_id: slug,
    model: draft.model,
    max_tokens: draft.max_tokens,
    updated_at: new Date().toISOString(),
    updated_by: user.id,
  });
  if (cfgErr) return { ok: false, errors: { form: cfgErr.message } };

  revalidatePath(`/agents/${slug}`);
  return { ok: true };
}

/**
 * One-click revert: read a prior override row and append a copy so it becomes the latest
 * active override (history stays append-only — nothing is deleted or mutated).
 */
export async function revertAgentOverride(slug: string, overrideId: string): Promise<SaveResult> {
  const user = await requireOps();
  const sb = await createClient();

  const { data: prior, error: readErr } = await sb.schema("orchestration")
    .from("agent_config_overrides")
    .select("agent_id, system_prompt, prompt_strategy, card, enabled_tools")
    .eq("id", overrideId)
    .eq("agent_id", slug)
    .single();
  if (readErr || !prior) return { ok: false, errors: { form: readErr?.message ?? "Version not found." } };

  const { error: insErr } = await sb.schema("orchestration").from("agent_config_overrides").insert({
    agent_id: prior.agent_id,
    system_prompt: prior.system_prompt,
    prompt_strategy: prior.prompt_strategy,
    card: prior.card,
    enabled_tools: prior.enabled_tools,
    updated_by: user.id,
  });
  if (insErr) return { ok: false, errors: { form: insErr.message } };

  revalidatePath(`/agents/${slug}`);
  return { ok: true };
}
