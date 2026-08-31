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

// ─── Tier 1 (#67 / #177): the config-agent corpus allow-list ────────────────────
//
// A config agent declares `knowledge_corpora` in its catalog row. The composer and
// catalog-validation.ts clamp that declaration to [shared, <ownSlug>, enduser] at
// AUTHOR time -- a bound on what may be STORED.
//
// As of #177 it is also enforced at READ time. A config agent has no retrieval path
// of its own: it runs the orchestrations it wires, and those used to call
// `scopeForAgent(<their own slug>)` unconditionally -- so a config agent that wired
// `dewey/knowledge-search` read dewey's private corpus regardless of its declaration.
//
// Now the dispatch token carries an `agent_slug` claim, routes/orchestrations.ts
// derives the caller's scope from that claim and the catalog row, and the run context
// carries it (`RunContext.knowledgeScope`). Retrieval orchestrations call
// `scopeForRun(ctx, "<donor>")` instead, which prefers the caller's scope.
//
// The claim is minted by the runtime, never sent by the agent Worker, and the scope is
// computed server-side from the catalog row -- a caller cannot widen its own access.
// `scopeForRun` can only ever NARROW: it never returns a scope broader than the
// orchestration's own would have been for a corpus the caller may not read.

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
 *
 * Enforced at read time as of #177: routes/orchestrations.ts calls this for a config-agent
 * caller and puts the result on `RunContext.knowledgeScope`, which `scopeForRun` returns.
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


// ─── Read scope for a running orchestration (#177) ──────────────────────────────

/**
 * The scope a retrieval orchestration should read under.
 *
 * Prefers the scope of the agent that INITIATED the run (`ctx.knowledgeScope`,
 * derived server-side from the dispatch token's `agent_slug` claim) over the
 * orchestration's own author slug.
 *
 * Falls back to `scopeForAgent(donorSlug)` for a direct run with no initiating agent,
 * which is the pre-#177 behaviour and remains correct there.
 *
 * For the six code agents this is a no-op: each wires only its own retrieval
 * orchestration, so caller slug and donor slug coincide. It changes behaviour only for
 * a config agent that wired someone else's orchestration -- exactly the gap in #177.
 */
export function scopeForRun(
  ctx: { knowledgeScope?: KnowledgeScope },
  donorSlug: string,
): KnowledgeScope {
  return ctx.knowledgeScope ?? scopeForAgent(donorSlug);
}
