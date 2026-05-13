-- Add beady/govcon-assessment and beady/past-performance-seed orchestration rows.
-- Both are n8n-backed thin wrappers; see orchestrations/beady/govcon-assessment/ and
-- orchestrations/beady/past-performance-seed/ for definitions.

INSERT INTO orchestration.orchestrations
  (name, version, description, input_schema, output_schema, is_active)
VALUES
  (
    'beady/govcon-assessment', 1,
    'Run a full GovCon qualification assessment via n8n — 5-dimensional scoring with RAG against past performance and capability statements',
    '{}', '{}', true
  ),
  (
    'beady/past-performance-seed', 1,
    'Embed a past performance record into n8n''s pgvector RAG so it is available for GovCon assessments',
    '{}', '{}', true
  )
ON CONFLICT (name, version) DO UPDATE SET
  description = EXCLUDED.description,
  is_active   = EXCLUDED.is_active,
  updated_at  = now();
