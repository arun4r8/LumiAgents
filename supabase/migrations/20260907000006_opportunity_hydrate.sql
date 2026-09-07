-- ============================================================================
-- Register beady/opportunity-hydrate + a daily schedule  (#219)
--
-- The sweep scores notices on their TITLES, because SAM v2's `description` field is
-- a link and fetching the body costs one subrequest per notice against a Cloudflare
-- ceiling of 50 per invocation. A 161-notice sweep cannot do that inline; that
-- fan-out is what killed five sweeps on 2026-09-07.
--
-- This runs in its own invocation with its own budget, 20 minutes after the sweep,
-- and works only on the shortlist -- a notice already rejected on its title is not
-- worth a subrequest.
--
-- Rollback:
--   DELETE FROM orchestration.schedules WHERE orchestration_name='beady/opportunity-hydrate';
--   DELETE FROM orchestration.orchestrations WHERE name='beady/opportunity-hydrate';
-- ============================================================================

INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES ('beady/opportunity-hydrate', 1,
  'Fetch the SAM notice body for shortlisted opportunities and re-score them on it, in its own subrequest budget.',
  '{}', '{}', true, 'cron')
ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;

INSERT INTO orchestration.schedules (orchestration_name, cron_expression, label, default_input, is_active)
SELECT 'beady/opportunity-hydrate', '20 8 * * *', 'Daily notice-text hydration + re-score', '{}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM orchestration.schedules WHERE orchestration_name = 'beady/opportunity-hydrate');
