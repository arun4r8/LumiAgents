-- ============================================================================
-- opportunities.source_file: which export a GovWin row came from
--
-- The BD pipeline table now shows where each opportunity came from, and "GovWin"
-- is not specific enough to act on: BD keeps four exports (Super Swath, VA,
-- State Local, Upcoming Deals) and they mean different things. The importer has
-- carried the filename per row all along (ImportRow.sourceFile, set inside the
-- per-workbook loop) and dropped it at the upsert.
--
-- source_url is not a substitute. It is the SharePoint Doc.aspx link, and the
-- name is only recoverable by parsing its `file=` query parameter -- which is
-- what the backfill below does, once, for rows imported before this column
-- existed. New rows get the name written directly.
--
-- Null for SAM.gov and SBIR rows: they have no export file, and `source` already
-- says what they are.
--
-- Rollback: ALTER TABLE public.opportunities DROP COLUMN source_file;
-- ============================================================================

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS source_file text;

COMMENT ON COLUMN public.opportunities.source_file IS
  'Export filename a GovWin row was imported from, e.g. "VA.xlsx". Null for SAM.gov and SBIR.';

-- Backfill from the `file=` parameter of the SharePoint link, URL-decoded.
UPDATE public.opportunities
SET source_file = replace(
      replace(substring(source_url from 'file=([^&]+)'), '%20', ' '),
      '%2520', ' ')
WHERE source = 'govwin'
  AND source_file IS NULL
  AND source_url LIKE '%file=%';
