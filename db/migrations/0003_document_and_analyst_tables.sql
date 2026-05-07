-- Migration 0003: Document RAG and Data Analyst tables
-- These replace the n8n LumiAnalysis workflow entirely.
-- Rollback: DROP TABLE orchestration.document_chunks, orchestration.orch_documents CASCADE;
--           DROP FUNCTION orchestration.analyst_query;

-- Enable pgvector (already enabled on project, but safe to re-run)
CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────────────────────────────────────
-- Document storage (source documents, any type)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE orchestration.orch_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name  text NOT NULL,          -- filename, URL slug, or human label
  source_kind  text NOT NULL           -- 'pdf' | 'text' | 'csv' | 'url'
                CHECK (source_kind IN ('pdf', 'text', 'csv', 'url')),
  storage_path text,                   -- Supabase Storage path if file-backed
  content      text NOT NULL,          -- full extracted text
  metadata     jsonb NOT NULL DEFAULT '{}',
  char_count   integer GENERATED ALWAYS AS (char_length(content)) STORED,
  ingested_by  uuid,                   -- auth.users(id)
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orch_documents_source_kind_idx ON orchestration.orch_documents(source_kind);
CREATE INDEX orch_documents_created_at_idx  ON orchestration.orch_documents(created_at DESC);

ALTER TABLE orchestration.orch_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON orchestration.orch_documents
  FOR ALL TO authenticated
  USING  ((auth.jwt() ->> 'role') = 'ops')
  WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

CREATE POLICY "enduser_read" ON orchestration.orch_documents
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'role') = 'enduser');

GRANT ALL    ON orchestration.orch_documents TO service_role;
GRANT SELECT ON orchestration.orch_documents TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- Document chunks with 1024-dim embeddings (Cloudflare Workers AI bge-large-en-v1.5)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE orchestration.document_chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES orchestration.orch_documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content     text NOT NULL,
  embedding   vector(1024),            -- Workers AI @cf/baai/bge-large-en-v1.5
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_chunks_document_id_idx ON orchestration.document_chunks(document_id);

-- IVFFlat index for fast approximate nearest-neighbour search
-- (rebuild with CONCURRENTLY once you have >1000 rows)
CREATE INDEX document_chunks_embedding_idx
  ON orchestration.document_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

ALTER TABLE orchestration.document_chunks ENABLE ROW LEVEL SECURITY;

-- Inherit visibility from parent document
CREATE POLICY "ops_all" ON orchestration.document_chunks
  FOR ALL TO authenticated
  USING  ((auth.jwt() ->> 'role') = 'ops')
  WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

CREATE POLICY "enduser_read" ON orchestration.document_chunks
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'role') = 'enduser');

GRANT ALL    ON orchestration.document_chunks TO service_role;
GRANT SELECT ON orchestration.document_chunks TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- Vector similarity search function (called by the RAG agent)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION orchestration.match_document_chunks(
  query_embedding vector(1024),
  match_count     integer DEFAULT 6,
  min_similarity  float   DEFAULT 0.5
)
RETURNS TABLE (
  id          uuid,
  document_id uuid,
  source_name text,
  chunk_index integer,
  content     text,
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
    1 - (dc.embedding <=> query_embedding) AS similarity
  FROM orchestration.document_chunks dc
  JOIN orchestration.orch_documents d ON d.id = dc.document_id
  WHERE 1 - (dc.embedding <=> query_embedding) >= min_similarity
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION orchestration.match_document_chunks TO service_role, authenticated;

-- ─────────────────────────────────────────────────────────────
-- Safe SQL execution for the Data Analyst agent
-- Only allows SELECT statements. Runs as service_role so it can
-- read all tables — the Worker validates the query before calling this.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION orchestration.analyst_query(query_sql text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  result     jsonb;
  normalized text;
BEGIN
  -- Strip leading whitespace/comments and uppercase for check
  normalized := upper(trim(regexp_replace(query_sql, '^(\s|--[^\n]*\n)*', '', 'g')));

  -- Block any non-SELECT statement
  IF normalized !~ '^SELECT\s' THEN
    RAISE EXCEPTION 'analyst_query only allows SELECT statements, got: %',
      left(normalized, 40);
  END IF;

  -- Block any attempt to call functions or modify data inline
  IF normalized ~* '(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|EXECUTE|DO\s)' THEN
    RAISE EXCEPTION 'analyst_query: forbidden keyword detected';
  END IF;

  EXECUTE format('SELECT jsonb_agg(t) FROM (%s) t', query_sql) INTO result;
  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION orchestration.analyst_query TO service_role;
-- Do NOT grant to authenticated — only the runtime (service_role) calls this
