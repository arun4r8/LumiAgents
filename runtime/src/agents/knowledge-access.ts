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
