-- Add cycle_status to awards so the sweep can persist the page-type / cycle
-- classification (open | closed | hub | unknown) alongside each scored award.
-- Nullable; no strict CHECK so future classifier values won't break inserts.
--
-- Rollback:
--   ALTER TABLE public.awards DROP COLUMN IF EXISTS cycle_status;

ALTER TABLE public.awards ADD COLUMN IF NOT EXISTS cycle_status text;
