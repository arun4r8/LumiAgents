// Tier 1 agent builder (#67) — pure validation for a config (catalog) agent draft.
//
// This module is the single source of truth for §3.3 validation of a NEW config agent
// (create + edit). It is imported BOTH by the dashboard server action (authoritative
// pre-write check, with the orchestration catalog fetched from GET /api/orchestrations and
// existing slugs read from the DB) AND by runtime unit tests. It stays pure — no CF /
// Supabase / fetch — so it is trivially testable and cannot drift between the two callers.
//
// Sync eligibility (#127): a tool may be wired `mode: 'sync'` only if its orchestration
// DECLARES `readOnly: true` (OrchestrationDefinition.readOnly), surfaced to callers on
// GET /api/orchestrations and enforced server-side by POST /:name/run-sync.
//
// This replaces the previous inference, which built the "provably read-only" set from any
// orchestration a code agent marked `mode: 'sync'`. That was unsound: mode belongs to the
// TRANSFORM, not the orchestration. agents/patch/index.ts marks `search_tickets` sync and
// `create_ticket`/`update_ticket` async on the SAME orchestration, so `patch/ticket-ops`
// — which creates Jira issues — was classified read-only and a config agent could have
// been pointed at it through the retrying inline path.

import { AGENTS } from "../../../agents";
import { MODELS } from "../config/models";
import { allowedCorporaFor } from "./knowledge-access";

export const SYSTEM_PROMPT_MAX = 8000;
export const MAX_TOKENS_MIN = 256;
export const MAX_TOKENS_MAX = 64000;

/** The reserved slugs of the hand-built code agents — a config agent may not collide. */
export function codeAgentSlugs(): string[] {
  return Object.keys(AGENTS);
}

/**
 * The names in `catalog` that declare `readOnly: true` — the only orchestrations a config
 * agent may wire as `mode: 'sync'`. Everything else is async-only.
 *
 * Takes the catalog as an argument rather than reading the registry, because this module
 * is imported by the Next.js dashboard, which cannot resolve the runtime's `@/runtime`
 * path alias. Feed it the payload of GET /api/orchestrations, which now carries `readOnly`.
 * No catalog → the empty set (fail closed: nothing is sync-eligible).
 */
export function readOnlyOrchestrations(
  catalog: readonly { name: string; readOnly?: boolean }[] = [],
): Set<string> {
  return new Set(catalog.filter((o) => o.readOnly === true).map((o) => o.name));
}

/** kebab-case slug: lowercase alphanumerics separated by single hyphens. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ToolDraft {
  orchestrationName: string;
  mode: "async" | "sync";
  params?: Record<string, unknown> | null;
}

export interface ConfigAgentDraft {
  slug: string;
  displayName: string;
  card: {
    emoji: string;
    category: string;
    description: string;
    suggestedPrompts?: string[];
  };
  systemPrompt: string;
  model: string;
  maxTokens: number;
  tools: ToolDraft[];
  knowledgeCorpora: string[];
}

/** What the validator needs to know about the live orchestration catalog. */
export interface OrchestrationInfo {
  name: string;
  isActive: boolean;
  /** From OrchestrationDefinition.readOnly, via GET /api/orchestrations. Absent → not
   *  sync-eligible (fail closed). */
  readOnly?: boolean;
}

export interface ValidateContext {
  /** Live orchestration catalog (GET /api/orchestrations ∪ DB is_active). */
  orchestrations: OrchestrationInfo[];
  /** Config-agent slugs already in the catalog (excluding the one being edited). */
  existingSlugs: string[];
}

/** Per-field error map; empty means the draft is valid (§3.3, transactional). */
export function validateConfigAgent(
  draft: ConfigAgentDraft,
  ctx: ValidateContext,
): Record<string, string> {
  const errors: Record<string, string> = {};

  // ── Identity ────────────────────────────────────────────────────────────────
  const slug = (draft.slug ?? "").trim();
  if (!slug) {
    errors.slug = "Slug is required.";
  } else if (!SLUG_RE.test(slug)) {
    errors.slug = "Slug must be kebab-case (lowercase letters, digits, single hyphens).";
  } else if (codeAgentSlugs().includes(slug)) {
    errors.slug = `"${slug}" is a reserved built-in agent.`;
  } else if (ctx.existingSlugs.includes(slug)) {
    errors.slug = `An agent with slug "${slug}" already exists.`;
  }

  if (!(draft.displayName ?? "").trim()) {
    errors.displayName = "Display name is required.";
  }

  // ── Card ────────────────────────────────────────────────────────────────────
  if (!(draft.card?.emoji ?? "").trim()) errors.emoji = "An emoji is required.";
  if (!(draft.card?.category ?? "").trim()) errors.category = "A category is required.";
  if (!(draft.card?.description ?? "").trim()) errors.description = "A description is required.";

  // ── Persona ─────────────────────────────────────────────────────────────────
  const prompt = (draft.systemPrompt ?? "").trim();
  if (!prompt) {
    errors.systemPrompt = "A system prompt (persona) is required.";
  } else if (prompt.length > SYSTEM_PROMPT_MAX) {
    errors.systemPrompt = `System prompt must be ${SYSTEM_PROMPT_MAX} characters or fewer (currently ${prompt.length}).`;
  }

  // ── Model ───────────────────────────────────────────────────────────────────
  if (!Object.values(MODELS).includes(draft.model as (typeof MODELS)[keyof typeof MODELS])) {
    errors.model = `Model must be one of: ${Object.values(MODELS).join(", ")}.`;
  }
  if (
    !Number.isInteger(draft.maxTokens) ||
    draft.maxTokens < MAX_TOKENS_MIN ||
    draft.maxTokens > MAX_TOKENS_MAX
  ) {
    errors.maxTokens = `Max tokens must be a whole number between ${MAX_TOKENS_MIN} and ${MAX_TOKENS_MAX}.`;
  }

  // ── Tools ───────────────────────────────────────────────────────────────────
  const active = new Map(ctx.orchestrations.map((o) => [o.name, o.isActive]));
  const readOnly = readOnlyOrchestrations(ctx.orchestrations);
  if (!draft.tools || draft.tools.length === 0) {
    errors.tools = "Select at least one tool (orchestration) for this agent.";
  } else {
    const seen = new Set<string>();
    const toolErrors: string[] = [];
    for (const t of draft.tools) {
      const name = t.orchestrationName;
      if (seen.has(name)) {
        toolErrors.push(`Duplicate tool: ${name}.`);
        continue;
      }
      seen.add(name);
      if (!active.has(name)) {
        toolErrors.push(`Unknown orchestration: ${name}.`);
      } else if (active.get(name) === false) {
        toolErrors.push(`Orchestration is inactive: ${name}.`);
      }
      if (t.mode === "sync" && !readOnly.has(name)) {
        toolErrors.push(`"${name}" is not declared readOnly and cannot run in sync mode.`);
      }
    }
    if (toolErrors.length > 0) errors.tools = toolErrors.join(" ");
  }

  // ── Knowledge ───────────────────────────────────────────────────────────────
  const allowed = new Set(allowedCorporaFor(slug || draft.slug));
  const badCorpora = (draft.knowledgeCorpora ?? []).filter((c) => !allowed.has(c));
  if (badCorpora.length > 0) {
    errors.knowledgeCorpora =
      `Knowledge corpora must be within [${[...allowed].join(", ")}]; ` +
      `remove: ${badCorpora.join(", ")}.`;
  }

  return errors;
}
