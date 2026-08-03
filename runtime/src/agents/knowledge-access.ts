// Knowledge access control. Agents all run as Postgres service_role and bypass RLS,
// so "which agent may read which corpus" is enforced here in the runtime and passed
// down to orchestration.match_document_chunks (allowed_corpora / include_restricted).
//
// Rule: every agent reads the central `shared` corpus plus its own private corpus.
// `restricted` sensitivity is ops-only and never returned to an agent unless the
// caller is an explicit ops/dashboard context.

export const SHARED_CORPUS = "shared";

export type Sensitivity = "internal" | "restricted";

export interface KnowledgeScope {
  /** Corpora this caller may read. `null` means no restriction (ops / dashboard). */
  allowedCorpora: string[] | null;
  /** Whether restricted-sensitivity documents may be returned. */
  includeRestricted: boolean;
}

/** Scope for an agent: the shared corpus + its own, internal sensitivity only. */
export function scopeForAgent(agentSlug: string): KnowledgeScope {
  return {
    allowedCorpora: [SHARED_CORPUS, agentSlug],
    includeRestricted: false,
  };
}

/** Scope for an ops / dashboard context: everything, including restricted. */
export const OPS_SCOPE: KnowledgeScope = {
  allowedCorpora: null,
  includeRestricted: true,
};

/** Corpus that endusers' own uploads land in — kept out of ops agents' retrieval
 *  (agents read [shared, <agentSlug>], never this corpus). Full per-user isolation
 *  is future work (private corpora); this at least fences enduser content off. */
export const ENDUSER_CORPUS = "enduser";

/** Scope for a signed-in enduser: the shared corpus + the enduser corpus, and
 *  NEVER restricted-sensitivity documents. */
export const ENDUSER_SCOPE: KnowledgeScope = {
  allowedCorpora: [SHARED_CORPUS, ENDUSER_CORPUS],
  includeRestricted: false,
};

/** Choose a read scope by caller role: ops gets everything, everyone else gets
 *  the enduser scope (shared + enduser corpus, no restricted). */
export function scopeForRole(role: string): KnowledgeScope {
  return role === "ops" ? OPS_SCOPE : ENDUSER_SCOPE;
}

// ─── Tier 1 (#67): bounded scope for a config (catalog) agent ───────────────────
//
// A config agent declares its own `knowledge_corpora` in the catalog. Unlike a code
// agent (whose scope is the hardcoded scopeForAgent(<slug>)), a config agent's declared
// scope is untrusted author input, so it is ALWAYS clamped here at read time — never
// restricted, and only corpora inside the agent's allowed set [shared, <ownSlug>, enduser].
// This is the runtime backstop that guarantees a config agent can never read another
// agent's private corpus or any restricted-sensitivity document, regardless of what a bad
// or stale catalog row claims. Author-time validation (catalog-validation.ts) mirrors it.

/** The corpora a config agent named `ownSlug` may ever be granted. */
export function allowedCorporaFor(ownSlug: string): string[] {
  return [SHARED_CORPUS, ownSlug, ENDUSER_CORPUS];
}

/**
 * Bounded read scope for a config agent. `declared` is the catalog's knowledge_corpora.
 *   - null/empty declared → falls back to [shared, <ownSlug>] (a code agent's default).
 *   - otherwise → the intersection of `declared` with the allowed set, so any stray or
 *     malicious corpus (another agent's slug, "restricted") is silently dropped.
 * `includeRestricted` is hard-wired false: a config agent is never ops.
 */
export function scopeForConfigAgent(
  ownSlug: string,
  declared?: string[] | null,
): KnowledgeScope {
  const allowed = new Set(allowedCorporaFor(ownSlug));
  const requested = (declared ?? []).filter((c) => allowed.has(c));
  const corpora = requested.length > 0 ? requested : [SHARED_CORPUS, ownSlug];
  return { allowedCorpora: corpora, includeRestricted: false };
}
