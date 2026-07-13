-- Give content_calendar rows a stable source_key so CSV imports (from the team's
-- planning spreadsheet) are idempotent: re-uploading an edited sheet updates the same
-- rows instead of duplicating. Manual rows leave source_key NULL (the partial unique
-- index allows any number of NULLs).
--
-- Rollback:
--   DROP INDEX IF EXISTS public.content_calendar_source_key_uidx;
--   ALTER TABLE public.content_calendar DROP COLUMN source_key;

ALTER TABLE public.content_calendar ADD COLUMN IF NOT EXISTS source_key text;

CREATE UNIQUE INDEX IF NOT EXISTS content_calendar_source_key_uidx
  ON public.content_calendar (source_key) WHERE source_key IS NOT NULL;
