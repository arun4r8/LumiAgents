-- Add angie/resume-formatting to the orchestration registry.
-- Idempotent via ON CONFLICT — safe to re-run.

INSERT INTO orchestration.orchestrations
  (name, version, description, input_schema, output_schema, is_active)
VALUES
  ('angie/resume-formatting', 1,
    'Reformat an employee''s existing resume for consulting client proposals. Tailors content to one of three target roles, removes weak language, quantifies impact, and trims to 3 pages.',
    '{}', '{}', true)

ON CONFLICT (name, version) DO UPDATE SET
  description = EXCLUDED.description,
  is_active   = EXCLUDED.is_active,
  updated_at  = now();
