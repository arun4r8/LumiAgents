-- Register the orchestrations that exist in code but not in the catalogue.
--
-- angie/resume-redact (#156) shipped in #158 without a registration, which made
-- both of its surfaces fail at runtime while every check passed. Chasing that
-- turned up four more in the same state, all of them shipped some time ago:
--
--   angie/recent-resume-jobs      Angie's "who scored well from today's batch"
--   beady/recent-opportunities    Beady's "what did today's sweep find"
--   cleo/recent-awards            Cleo's "what did the award sweep find"
--   cleo/recent-content           Cleo's "what have you done in the calendar"
--
-- All four are readOnly sync tools an agent reaches for mid-conversation. None
-- has ever produced a run in production, because the shared starter behind /run
-- and /run-sync calls getOrchestrationByName(), which throws when the row is
-- missing (runtime/src/db/client.ts). So every time an agent used one it failed.
-- Nothing surfaced it: the registry is TypeScript, the catalogue is SQL, and the
-- two were only ever compared at request time against a live database.
--
-- runtime/tests/unit/orchestration-registration.test.ts now compares them at
-- build time, so the next one cannot ship quietly.
--
-- input_schema / output_schema stay '{}' to match the other 28 rows: the run
-- form is built from the code registry, not from these columns.
--
-- Rollback:
--   DELETE FROM orchestration.orchestrations
--    WHERE name IN ('angie/resume-redact','angie/recent-resume-jobs',
--                   'beady/recent-opportunities','cleo/recent-awards',
--                   'cleo/recent-content');

INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES
  ('angie/resume-redact', 1,
    'Blind resume export: strips the candidate name, contact details and personal links, verifies the result deterministically, and returns text ready to render on Lumiture letterhead.',
    '{}', '{}', true, 'agent'),
  ('angie/recent-resume-jobs', 1,
    'Top-scored candidates from resume scoring jobs run recently, ranked by overall score.',
    '{}', '{}', true, 'agent'),
  ('beady/recent-opportunities', 1,
    'Opportunities the sweep has touched recently, ranked by fit score.',
    '{}', '{}', true, 'agent'),
  ('cleo/recent-awards', 1,
    'Awards the sweep has found or touched recently, ranked by fit score.',
    '{}', '{}', true, 'agent'),
  ('cleo/recent-content', 1,
    'Content calendar items updated recently (drafted, advanced, or synced), most recent first.',
    '{}', '{}', true, 'agent')
ON CONFLICT (name, version) DO UPDATE
  SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;
