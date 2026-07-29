-- Fix the content-calendar Graph sync (#60). PR #98 shipped the orchestration but:
--   1. never registered cleo/content-sync in the orchestration catalog, so it could not
--      be dispatched (the meta-cron and the /run endpoint both look it up there), and
--   2. left content_calendar.source_key under a PARTIAL unique index, which PostgREST's
--      ON CONFLICT cannot use, so the upsert failed with 42P10. (This also silently broke
--      the CSV import, which upserts on the same key.)
-- Registers the orchestration + a daily schedule and swaps the index for a plain unique
-- index (still allows multiple NULL source_keys for manually-added rows).

INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES ('cleo/content-sync', 1,
  'Live-sync the content calendar from the team''s Microsoft 365 planning workbook via Microsoft Graph; upserts rows keyed on source_key.',
  '{}', '{}', true, 'manual')
ON CONFLICT (name, version) DO UPDATE
  SET description = EXCLUDED.description, is_active = EXCLUDED.is_active, trigger_mode = EXCLUDED.trigger_mode;

INSERT INTO orchestration.schedules (orchestration_name, label, cron_expression, is_active, default_input)
SELECT 'cleo/content-sync', 'Daily content-calendar Graph sync', '0 8 * * *', true, '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM orchestration.schedules WHERE orchestration_name = 'cleo/content-sync');

DROP INDEX IF EXISTS public.content_calendar_source_key_uidx;
CREATE UNIQUE INDEX content_calendar_source_key_uidx ON public.content_calendar (source_key);
