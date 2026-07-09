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
