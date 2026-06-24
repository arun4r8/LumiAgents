-- Agent memory, Phase 2: semantic recall. Mirrors orchestration.document_chunks +
-- match_document_chunks (1024-dim Workers AI bge embeddings, ivfflat cosine). Each
-- chat turn is embedded into memory_chunks; recall pulls the most relevant past
-- turns/summaries for the same (user, agent) into the prompt.
--
-- Rollback:
--   DROP FUNCTION orchestration.match_memory(vector,uuid,text,int,float);
--   DROP TABLE orchestration.memory_chunks;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS orchestration.memory_chunks (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid,
  agent_slug        text        NOT NULL,
  conversation_id   uuid        REFERENCES orchestration.conversations(id) ON DELETE CASCADE,
  source_message_id uuid,
  kind              text        NOT NULL DEFAULT 'turn' CHECK (kind IN ('turn', 'summary', 'fact')),
  content           text        NOT NULL,
  embedding         vector(1024),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_chunks_user_agent_idx ON orchestration.memory_chunks(user_id, agent_slug);
CREATE INDEX IF NOT EXISTS memory_chunks_embedding_idx
  ON orchestration.memory_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

ALTER TABLE orchestration.memory_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON orchestration.memory_chunks FOR ALL TO authenticated
  USING (public.is_ops()) WITH CHECK (public.is_ops());
CREATE POLICY "owner_rw" ON orchestration.memory_chunks FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
GRANT ALL ON orchestration.memory_chunks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.memory_chunks TO authenticated;

-- Semantic recall scoped to one (user, agent). SECURITY DEFINER, so user scoping is
-- enforced in the function via p_user_id (no cross-user leakage).
CREATE OR REPLACE FUNCTION orchestration.match_memory(
  query_embedding vector(1024),
  p_user_id       uuid,
  p_agent_slug    text,
  match_count     int   DEFAULT 5,
  min_similarity  float DEFAULT 0.3
) RETURNS TABLE (id uuid, content text, kind text, similarity float)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = orchestration, public, extensions AS $$
  SELECT mc.id, mc.content, mc.kind, 1 - (mc.embedding <=> query_embedding) AS similarity
  FROM orchestration.memory_chunks mc
  WHERE mc.embedding IS NOT NULL
    AND mc.user_id = p_user_id
    AND mc.agent_slug = p_agent_slug
    AND 1 - (mc.embedding <=> query_embedding) >= min_similarity
  ORDER BY mc.embedding <=> query_embedding
  LIMIT match_count;
$$;
REVOKE ALL ON FUNCTION orchestration.match_memory(vector, uuid, text, int, float) FROM public;
GRANT EXECUTE ON FUNCTION orchestration.match_memory(vector, uuid, text, int, float) TO service_role, authenticated;
