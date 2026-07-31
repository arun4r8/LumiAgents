-- Two-way content-calendar sync (sheet <-> app). Adds the state the bidirectional
-- engine needs on top of the existing one-way columns:
--
--   sheet_id   text  — stable identity of the matching row in the Microsoft 365
--                      Excel table (the sheet's `id` column). NULL until a row has
--                      been linked to a sheet row (app-origin rows are pushed to the
--                      sheet and then get their generated id back here).
--   sync_base  jsonb — last-synced {topic, description, asset_ref} snapshot. This is
--                      the shared ancestor for the 3-way merge: on each run we diff
--                      the sheet value and the app value against this base to decide
--                      which side changed (both-changed → app wins), then rewrite the
--                      base to the resolved values.
--
-- `sheet_id` gets a PARTIAL unique index (only where NOT NULL) so many app-origin
-- rows can sit with NULL sheet_id before their first push. We never ON CONFLICT on
-- sheet_id (the engine matches/links explicitly), so the partial index is fine.
--
-- The engine is `cleo/content-sync` v2 (replaces the one-way v1). Register v2 in the
-- orchestration catalog so the /run endpoint and meta-cron can dispatch it — the run
-- handler looks the row up by (name, version) and the code now reports version 2.
--
-- Rollback:
--   DROP INDEX IF EXISTS public.content_calendar_sheet_id_uidx;
--   ALTER TABLE public.content_calendar DROP COLUMN IF EXISTS sync_base;
--   ALTER TABLE public.content_calendar DROP COLUMN IF EXISTS sheet_id;
--   DELETE FROM orchestration.orchestrations WHERE name = 'cleo/content-sync' AND version = 2;

ALTER TABLE public.content_calendar ADD COLUMN IF NOT EXISTS sheet_id text;
ALTER TABLE public.content_calendar ADD COLUMN IF NOT EXISTS sync_base jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS content_calendar_sheet_id_uidx
  ON public.content_calendar (sheet_id) WHERE sheet_id IS NOT NULL;

-- Register the two-way engine (v2). The v1 row stays for history; dispatch uses the
-- version the code advertises (now 2), so this row must exist or /run 404s.
INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES ('cleo/content-sync', 2,
  'Two-way content-calendar sync between the app and the Microsoft 365 Excel table (3-way merge, app-wins on conflict; adopts legacy CSV rows; never deletes).',
  '{}', '{}', true, 'manual')
ON CONFLICT (name, version) DO UPDATE
  SET description = EXCLUDED.description, is_active = EXCLUDED.is_active, trigger_mode = EXCLUDED.trigger_mode;
