// Tier 0 agent customization (#67) — shared constants + validation for the "Customize
// agent" panel and its server action. Imported by both the client panel (constants +
// live validation) and the server action (authoritative validation before write).
//
// The allowed model set is the single source of truth in runtime/src/config/models.ts,
// mirrored here so the dropdown and the §3.3 `model ∈ MODELS` check can't drift.
import { MODELS } from "../../runtime/src/config/models";

export const ALLOWED_MODELS: readonly string[] = Object.values(MODELS);

export const MAX_TOKENS_MIN = 256;
export const MAX_TOKENS_MAX = 64000;
export const SYSTEM_PROMPT_MAX = 8000;

export type PromptStrategy = "append" | "replace";

export interface OverrideDraft {
  system_prompt: string | null;
  prompt_strategy: PromptStrategy;
  enabled_tools: string[] | null; // null = all of the agent's tools
  model: string;
  max_tokens: number;
}

/** Result of a save/revert server action: ok, or a per-field error map (§3.3). */
export type SaveResult = { ok: true } | { ok: false; errors: Record<string, string> };

/**
 * The §3.3 validation subset relevant to Tier 0. Returns a per-field error map; an empty
 * map means the draft is valid. `agentToolNames` is the agent's real tool set — the
 * enabled subset must be ⊆ of it.
 */
export function validateOverride(
  draft: OverrideDraft,
  agentToolNames: string[],
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!ALLOWED_MODELS.includes(draft.model)) {
    errors.model = `Model must be one of: ${ALLOWED_MODELS.join(", ")}.`;
  }

  if (
    !Number.isInteger(draft.max_tokens) ||
    draft.max_tokens < MAX_TOKENS_MIN ||
    draft.max_tokens > MAX_TOKENS_MAX
  ) {
    errors.max_tokens = `Max tokens must be a whole number between ${MAX_TOKENS_MIN} and ${MAX_TOKENS_MAX}.`;
  }

  const prompt = (draft.system_prompt ?? "").trim();
  if (draft.prompt_strategy === "replace" && prompt.length === 0) {
    errors.system_prompt = "Replace strategy requires a non-empty system prompt.";
  } else if (prompt.length > SYSTEM_PROMPT_MAX) {
    errors.system_prompt = `System prompt must be ${SYSTEM_PROMPT_MAX} characters or fewer (currently ${prompt.length}).`;
  }

  if (draft.enabled_tools) {
    if (draft.enabled_tools.length === 0) {
      errors.enabled_tools = "Enable at least one tool.";
    } else {
      const unknown = draft.enabled_tools.filter((t) => !agentToolNames.includes(t));
      if (unknown.length > 0) {
        errors.enabled_tools = `Unknown tools for this agent: ${unknown.join(", ")}.`;
      }
    }
  }

  return errors;
}
