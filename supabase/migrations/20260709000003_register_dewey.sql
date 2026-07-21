-- Register Dewey's orchestrations. Dewey is the knowledge librarian: an additive,
-- curatorial agent over the shared corpus (it does not own the ingest pipeline; Patch
-- keeps that). All three are agent-triggered / on-demand (no schedule).
--
-- Rollback:
--   DELETE FROM orchestration.orchestrations WHERE name LIKE 'dewey/%';

INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES
  ('dewey/knowledge-search', 1,
    'Answer a question from the shared central knowledge base (RAG over the shared corpus).',
    '{}', '{}', true, 'agent'),
  ('dewey/retag-document', 1,
    'Re-tag a document''s corpus and/or sensitivity, Dewey''s curation of the knowledge base.',
    '{}', '{}', true, 'agent'),
  ('dewey/knowledge-inventory', 1,
    'Summarize the knowledge base: counts by corpus and sensitivity, plus recent documents.',
    '{}', '{}', true, 'agent')
ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;
