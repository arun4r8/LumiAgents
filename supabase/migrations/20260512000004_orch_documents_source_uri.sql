-- Migration: add source_uri to orchestration.orch_documents
--
-- Enables idempotent upserts for the Obsidian vault sync integration.
-- Each vault file gets a stable source_uri = 'github:{owner}/{repo}:{path}'.
-- On re-sync, the worker deletes the existing row (cascading to document_chunks)
-- and re-inserts with fresh embeddings. The unique constraint prevents duplicate
-- ingestion if a webhook fires twice for the same file.
--
-- Existing rows (manually ingested documents) keep source_uri = NULL; the
-- unique constraint uses NULLS NOT DISTINCT so multiple NULL values are allowed.
--
-- Rollback:
--   ALTER TABLE orchestration.orch_documents DROP COLUMN IF EXISTS source_uri;

ALTER TABLE orchestration.orch_documents
  ADD COLUMN IF NOT EXISTS source_uri text;

CREATE UNIQUE INDEX IF NOT EXISTS orch_documents_source_uri_uidx
  ON orchestration.orch_documents (source_uri)
  WHERE source_uri IS NOT NULL;
