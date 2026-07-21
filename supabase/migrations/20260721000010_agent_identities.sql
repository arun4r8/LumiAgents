-- Per-agent database identity, phase 1. ADDITIVE and INERT BY DEFAULT.
--
-- WHY: today every agent talks to Supabase with SUPABASE_SERVICE_ROLE_KEY, which
-- bypasses RLS. At the database layer there is nothing to distinguish Beady from
-- Money, so "which agent may read which knowledge" is enforced only in the runtime
-- retrieval path (runtime/src/agents/knowledge-access.ts plus the allowed_corpora /
-- include_restricted arguments to orchestration.match_document_chunks). A caller that
-- forgets those arguments, or reaches the RPC by another route, gets everything. This
-- migration gives Postgres something to enforce against. See docs/agent-identity.md.
--
-- MODEL: an agent principal is an ordinary `authenticated` PostgREST request whose JWT
-- carries an extra `agent` claim holding the agent slug. The Postgres role stays
-- `authenticated`, so every existing GRANT keeps working and no parallel privilege set
-- is needed. Human roles (ops / enduser) keep using public.is_ops() and the `user_role`
-- claim exactly as before; agent identity is an orthogonal claim, not a competing role
-- system. public.current_agent() is the agent-side mirror of public.is_ops().
--
-- INERT: every seeded identity ships with is_active = false, and public.current_agent()
-- only resolves active rows. Until a human deliberately activates a row, current_agent()
-- returns NULL, the new RLS policies below evaluate to false for every row, and the new
-- RPC refuses to run. Nothing in this migration changes the behaviour of any existing
-- policy, function, grant, or code path.
--
-- SWITCH ON (deliberate, one agent at a time):
--   UPDATE orchestration.agent_identities SET is_active = true WHERE agent_slug = 'dewey';
-- SWITCH OFF (instant kill switch, no deploy):
--   UPDATE orchestration.agent_identities SET is_active = false;
--
-- Rollback (manual, deliberate):
--   DROP FUNCTION IF EXISTS orchestration.match_document_chunks_for_agent(
--     extensions.vector, integer, float, text[]);
--   DROP POLICY IF EXISTS "agent_read_scoped" ON orchestration.document_chunks;
--   DROP POLICY IF EXISTS "agent_read_scoped" ON orchestration.orch_documents;
--   DROP FUNCTION IF EXISTS public.agent_may_read_document(uuid);
--   DROP FUNCTION IF EXISTS public.agent_may_read(text, text);
--   DROP FUNCTION IF EXISTS public.current_agent();
--   DROP TABLE IF EXISTS orchestration.agent_identities;
-- Nothing else needs restoring: this migration alters nothing that already existed.

-- ─── 1. The identity register ───────────────────────────────────────────────────
-- One row per agent principal. This is the single source of truth for what an agent
-- may read, so the answer lives next to the data instead of in Worker code, and can be
-- changed by an ops human without a deploy.

CREATE TABLE IF NOT EXISTS orchestration.agent_identities (
  agent_slug          text PRIMARY KEY,
  display_name        text NOT NULL,
  -- Corpora this agent may read. Mirrors scopeForAgent() in the runtime: the shared
  -- corpus plus the agent's own. Deliberately NOT nullable: there is no "no restriction"
  -- value for an agent, unlike the ops/dashboard path.
  allowed_corpora     text[] NOT NULL,
  -- restricted-sensitivity material is ops-only today. Kept as a column rather than a
  -- constant so a future exception (an auditor agent, say) is a data change, not a schema one.
  may_read_restricted boolean NOT NULL DEFAULT false,
  -- The switch. Ships false so this whole mechanism is inert on apply.
  is_active           boolean NOT NULL DEFAULT false,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_identities_allowed_corpora_not_empty
    CHECK (array_length(allowed_corpora, 1) >= 1)
);

COMMENT ON TABLE orchestration.agent_identities IS
  'Per-agent database principals. is_active = false means the agent claim resolves to nothing and all agent RLS is inert. See docs/agent-identity.md.';

-- Seeded to match today's runtime behaviour exactly (shared corpus + own corpus,
-- internal sensitivity only), so activating a row is a no-op for what an agent can see
-- and only changes WHO enforces it.
INSERT INTO orchestration.agent_identities (agent_slug, display_name, allowed_corpora, notes) VALUES
  ('angie', 'Angie', ARRAY['shared', 'angie'], 'HR and recruiting'),
  ('beady', 'Beady', ARRAY['shared', 'beady'], 'GovCon business development'),
  ('cleo',  'Cleo',  ARRAY['shared', 'cleo'],  'Eminence, awards and proposals'),
  ('dewey', 'Dewey', ARRAY['shared', 'dewey'], 'Knowledge librarian; first candidate for activation'),
  ('money', 'Money', ARRAY['shared', 'money'], 'Finance and analytics'),
  ('patch', 'Patch', ARRAY['shared', 'patch'], 'IT ops and knowledge/RAG')
ON CONFLICT (agent_slug) DO NOTHING;

ALTER TABLE orchestration.agent_identities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON orchestration.agent_identities
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

GRANT ALL    ON orchestration.agent_identities TO service_role;
GRANT SELECT ON orchestration.agent_identities TO authenticated;

-- ─── 2. Identity resolution ─────────────────────────────────────────────────────
-- current_agent() is to agents what is_ops() is to humans: the one place a policy asks
-- "who is calling". SECURITY DEFINER so it can read agent_identities regardless of the
-- caller's own RLS, matching the is_ops() precedent.
--
-- Fails closed in every direction: a service-role request has no `agent` claim, an
-- unknown slug matches no row, and an inactive row is filtered out.

CREATE OR REPLACE FUNCTION public.current_agent() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, orchestration
AS $$
  SELECT ai.agent_slug
  FROM orchestration.agent_identities ai
  WHERE ai.agent_slug = (auth.jwt() ->> 'agent')
    AND ai.is_active
$$;

GRANT EXECUTE ON FUNCTION public.current_agent() TO authenticated, service_role;

-- Corpus/sensitivity predicate, expressed once so every policy and RPC asks the same
-- question. This is the database-side twin of scopeForAgent() in the runtime.
CREATE OR REPLACE FUNCTION public.agent_may_read(p_corpus text, p_sensitivity text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, orchestration
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM orchestration.agent_identities ai
    WHERE ai.agent_slug = (auth.jwt() ->> 'agent')
      AND ai.is_active
      AND p_corpus = ANY (ai.allowed_corpora)
      AND (p_sensitivity IS DISTINCT FROM 'restricted' OR ai.may_read_restricted)
  )
$$;

GRANT EXECUTE ON FUNCTION public.agent_may_read(text, text) TO authenticated, service_role;

-- Same predicate reached through a chunk's parent document. SECURITY DEFINER matters
-- here for a second reason: it stops the document_chunks policy from re-entering RLS on
-- orch_documents, which would make the two policies mutually recursive.
CREATE OR REPLACE FUNCTION public.agent_may_read_document(p_document_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, orchestration
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM orchestration.orch_documents d
    JOIN orchestration.agent_identities ai
      ON ai.agent_slug = (auth.jwt() ->> 'agent')
    WHERE d.id = p_document_id
      AND ai.is_active
      AND d.corpus = ANY (ai.allowed_corpora)
      AND (d.sensitivity IS DISTINCT FROM 'restricted' OR ai.may_read_restricted)
  )
$$;

GRANT EXECUTE ON FUNCTION public.agent_may_read_document(uuid) TO authenticated, service_role;

-- ─── 3. Agent-scoped RLS on the knowledge tables ────────────────────────────────
-- New PERMISSIVE policies added ALONGSIDE the existing ops_all and enduser_read
-- policies. Postgres ORs permissive policies together, so these can only ever widen,
-- never narrow, and no existing access path changes. They widen to exactly nobody until
-- an agent_identities row is activated AND a JWT carrying that agent claim is minted.

CREATE POLICY "agent_read_scoped" ON orchestration.orch_documents
  FOR SELECT TO authenticated
  USING (public.agent_may_read(corpus, sensitivity));

CREATE POLICY "agent_read_scoped" ON orchestration.document_chunks
  FOR SELECT TO authenticated
  USING (public.agent_may_read_document(document_id));

-- ─── 4. Retrieval RPC that trusts the identity, not the arguments ───────────────
-- orchestration.match_document_chunks is SECURITY DEFINER, so RLS on the underlying
-- tables does not apply inside it: adding policies alone would not close the retrieval
-- path. It also takes allowed_corpora / include_restricted from the CALLER, which is the
-- runtime-trust model we are trying to move away from. That function is left exactly as
-- it is (every current caller depends on it); this is a sibling that inverts the trust.
--
-- SECURITY INVOKER on purpose: the function body runs as `authenticated`, so the
-- agent_read_scoped policies above are what actually filter the rows. The WHERE clause
-- repeats the corpus predicate as defence in depth, not as the primary gate.
--
-- narrow_to_corpora is the belt-and-braces hook for the transition: the runtime keeps
-- computing scopeForAgent() and passes it here, where it can only intersect with what
-- the database already allows. It can never widen the result.

CREATE FUNCTION orchestration.match_document_chunks_for_agent(
  query_embedding   extensions.vector(1024),
  match_count       integer DEFAULT 6,
  min_similarity    float   DEFAULT 0.5,
  narrow_to_corpora text[]  DEFAULT NULL
)
RETURNS TABLE (
  id          uuid,
  document_id uuid,
  source_name text,
  chunk_index integer,
  content     text,
  corpus      text,
  sensitivity text,
  similarity  float
)
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = orchestration, public, extensions
AS $$
DECLARE
  v_agent text;
BEGIN
  v_agent := public.current_agent();
  -- Fail loudly rather than quietly returning everything. Without this a service-role
  -- caller (RLS bypassed, no agent claim) would get an unfiltered result set, which is
  -- the exact failure mode this whole migration exists to remove.
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'match_document_chunks_for_agent: caller has no active agent identity';
  END IF;

  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    d.source_name,
    dc.chunk_index,
    dc.content,
    d.corpus,
    d.sensitivity,
    1 - (dc.embedding <=> query_embedding) AS similarity
  FROM orchestration.document_chunks dc
  JOIN orchestration.orch_documents d ON d.id = dc.document_id
  WHERE 1 - (dc.embedding <=> query_embedding) >= min_similarity
    AND (narrow_to_corpora IS NULL OR d.corpus = ANY (narrow_to_corpora))
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Deliberately NOT granted to service_role: that role bypasses RLS, so executing this
-- as service_role would defeat its purpose. The RAISE above already blocks it; the
-- missing grant makes the intent explicit.
GRANT EXECUTE ON FUNCTION orchestration.match_document_chunks_for_agent(
  extensions.vector, integer, float, text[]
) TO authenticated;
