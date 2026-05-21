-- Migration: add 'vault' to orch_documents source_kind check constraint
--
-- The vault-sync orchestration ingests Obsidian vault notes into the RAG index.
-- Previously these rows were stored as source_kind = 'text' (the only text-like
-- option available at schema creation time), making them indistinguishable from
-- manually ingested plain-text documents.
--
-- Adding 'vault' as a distinct kind lets the Knowledge Base page (and any future
-- queries) filter vault documents cleanly without relying on source_uri patterns.
--
-- Existing vault rows (source_uri LIKE 'github:%' AND source_kind = 'text') are
-- back-filled to 'vault' in the same transaction.
--
-- Rollback:
--   UPDATE orchestration.orch_documents SET source_kind = 'text' WHERE source_kind = 'vault';
--   ALTER TABLE orchestration.orch_documents DROP CONSTRAINT orch_documents_source_kind_check;
--   ALTER TABLE orchestration.orch_documents ADD CONSTRAINT orch_documents_source_kind_check
--     CHECK (source_kind IN ('pdf', 'text', 'csv', 'url'));

ALTER TABLE orchestration.orch_documents
  DROP CONSTRAINT IF EXISTS orch_documents_source_kind_check;

ALTER TABLE orchestration.orch_documents
  ADD CONSTRAINT orch_documents_source_kind_check
  CHECK (source_kind IN ('pdf', 'text', 'csv', 'url', 'vault'));

UPDATE orchestration.orch_documents
  SET source_kind = 'vault'
  WHERE source_uri LIKE 'github:%'
    AND source_kind = 'text';
