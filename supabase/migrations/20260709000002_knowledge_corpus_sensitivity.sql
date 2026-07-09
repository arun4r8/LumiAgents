-- Knowledge separation, phase 1: tag every document with a *corpus* (ownership /
-- visibility) and a *sensitivity* (how far it may travel), and teach the retrieval
-- RPC to enforce both. Agents all execute as service_role (they bypass RLS), so the
-- gate lives here in the RPC — each agent passes the corpora it's allowed to read.
--
-- Model:
--   corpus       'shared' (central knowledge every agent reads) or an agent slug
--                ('beady','money',…) for that agent's private corpus. Default 'shared'.
--   sensitivity  'internal' (default — team-usable, may ground outward drafts) or
--                'restricted' (financials / client-confidential / security — ops-only,
--                never surfaces in agent retrieval unless include_restricted is set).
--
-- Backfill is a no-op for behavior: existing rows become shared/internal, so every
-- agent still reads everything until documents are deliberately re-tagged.
--
-- Rollback:
--   ALTER TABLE orchestration.orch_documents DROP COLUMN corpus, DROP COLUMN sensitivity;
--   -- and restore the 3-arg match_document_chunks from migration 0003.

ALTER TABLE orchestration.orch_documents
  ADD COLUMN IF NOT EXISTS corpus      text NOT NULL DEFAULT 'shared',
  ADD COLUMN IF NOT EXISTS sensitivity text NOT NULL DEFAULT 'internal'
    CHECK (sensitivity IN ('internal', 'restricted'));

CREATE INDEX IF NOT EXISTS orch_documents_corpus_idx
  ON orchestration.orch_documents (corpus, sensitivity);

-- Recreate the retrieval RPC with corpus/sensitivity filtering. Adding parameters
-- changes the function's identity, so drop the old 3-arg signature first to avoid an
-- ambiguous overload.
DROP FUNCTION IF EXISTS orchestration.match_document_chunks(vector, integer, float);

CREATE FUNCTION orchestration.match_document_chunks(
  query_embedding    vector(1024),
  match_count        integer   DEFAULT 6,
  min_similarity     float     DEFAULT 0.5,
  allowed_corpora    text[]    DEFAULT NULL,   -- NULL = no corpus restriction (ops/dashboard)
  include_restricted boolean   DEFAULT false   -- true = also return sensitivity='restricted'
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
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
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
    AND (allowed_corpora IS NULL OR d.corpus = ANY(allowed_corpora))
    AND (include_restricted OR d.sensitivity <> 'restricted')
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION orchestration.match_document_chunks TO service_role, authenticated;
