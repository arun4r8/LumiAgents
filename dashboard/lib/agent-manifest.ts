// Tier 1 agent builder (#67) — the composer's manifest draft shape (client-safe: no runtime
// imports, so it can live in the client bundle). The authoritative §3.3 validation runs in
// the server action via the shared runtime validateConfigAgent(); this file is just the
// form's data contract + the small helpers both the client and the action share.

import { MODELS } from "../../runtime/src/config/models";

export const ALLOWED_MODELS: readonly string[] = Object.values(MODELS);

export const SYSTEM_PROMPT_MAX = 8000;
export const MAX_TOKENS_MIN = 256;
export const MAX_TOKENS_MAX = 64000;
export const DEFAULT_MAX_TOKENS = 2048;

export type ToolMode = "async" | "sync";

export interface ToolDraft {
  orchestrationName: string;
  mode: ToolMode;
  /** Fixed params merged under the model's tool input (e.g. { channel: "instagram" }). */
  params?: Record<string, unknown> | null;
}

export interface AgentManifestDraft {
  slug: string;
  displayName: string;
  emoji: string;
  category: string;
  description: string;
  suggestedPrompts: string[];
  systemPrompt: string;
  model: string;
  maxTokens: number;
  tools: ToolDraft[];
  knowledgeCorpora: string[];
}

/** Server-action result: ok (with the slug to navigate to) or a per-field error map. */
export type SaveResult =
  | { ok: true; slug: string }
  | { ok: false; errors: Record<string, string> };

/** The corpora a config agent named `slug` may select (never `restricted`). */
export function knowledgeOptionsFor(slug: string): string[] {
  return ["shared", slug || "<slug>", "enduser"];
}

/** A blank manifest for the "New agent" composer. */
export function emptyManifest(): AgentManifestDraft {
  return {
    slug: "",
    displayName: "",
    emoji: "🤖",
    category: "",
    description: "",
    suggestedPrompts: [],
    systemPrompt: "",
    model: ALLOWED_MODELS[0] ?? "claude-sonnet-4-6",
    maxTokens: DEFAULT_MAX_TOKENS,
    tools: [],
    knowledgeCorpora: ["shared"],
  };
}
