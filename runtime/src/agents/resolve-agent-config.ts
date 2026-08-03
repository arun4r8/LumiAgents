import type { SupabaseClient } from "../db/client";
import type { AgentModelConfig, AgentOverrideInput } from "./agent-chat";

// Tier 0 (#67): the gateway resolves an agent's chat config here because the agent's own
// Worker (AgentEnv) has no Supabase access. The result is threaded into the chat request
// (like `memoryPreamble`) so runAgentChat can stay DB-free and testable.

export interface ResolvedAgentConfig {
  modelConfig?: AgentModelConfig;
  override?: AgentOverrideInput;
}

/**
 * Resolve the per-agent model config (orchestration.agent_configs) and the latest
 * persona/tool override (orchestration.agent_config_overrides) for the chat loop.
 *
 * Best-effort by design: any DB failure (missing row, unreachable Supabase) yields an
 * empty slice, so the chat loop falls back to its hardcoded defaults — byte-identical to
 * pre-Tier-0 behavior. Never throws.
 */
export async function resolveAgentChatConfig(
  db: SupabaseClient,
  slug: string,
): Promise<ResolvedAgentConfig> {
  const [cfg, ovr] = await Promise.all([
    db.getAgentConfig(slug).catch(() => null),
    db.getAgentOverrides(slug).catch(() => null),
  ]);

  const out: ResolvedAgentConfig = {};

  if (cfg) {
    out.modelConfig = { model: cfg.model, maxTokens: cfg.max_tokens };
  }

  if (ovr) {
    out.override = {
      systemPrompt: ovr.system_prompt,
      promptStrategy: ovr.prompt_strategy,
      enabledTools: Array.isArray(ovr.enabled_tools) ? ovr.enabled_tools : null,
    };
  }

  return out;
}
