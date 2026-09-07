-- ============================================================================
-- Backfill opportunities.agency: split SAM's period-delimited hierarchy
--
-- `fullParentPathName` from the SAM.gov v2 API is PERIOD-delimited:
--
--   "COMMERCE, DEPARTMENT OF.NATIONAL OCEANIC AND ATMOSPHERIC ADMINISTRATION.
--    DEPT OF COMMERCE NOAA"
--
-- The parser split it on ">", a delimiter SAM never uses, so `agency` was set to
-- the ENTIRE undivided path on every SAM notice ever stored -- 155 of 155 rows --
-- and the sub-agency was discarded.
--
-- That string is not merely ugly. It is on the opportunity card, in the digest
-- email, and in the payload handed to the scoring model as the notice's agency, so
-- "which agency is this for" has been unanswerable by any consumer.
--
-- This takes the first period-delimited segment, which is the department. It does
-- NOT reconstruct the sub-agency: that segment was never stored, and re-deriving it
-- would mean re-fetching every notice from SAM. New rows get both from the fixed
-- parser; these keep the department and a null sub-agency, which is at least true.
--
-- Scoped to rows that still hold an unsplit path (`agency LIKE '%.%'`). A row whose
-- agency is already a single clean segment is left alone, so this is idempotent and
-- safe to re-run.
--
-- Note the delimiter is a period and the segments themselves contain commas
-- ("VETERANS AFFAIRS, DEPARTMENT OF"), so split_part on ',' would be wrong.
-- ============================================================================

UPDATE public.opportunities
SET agency = split_part(agency, '.', 1)
WHERE source = 'sam_gov'
  AND agency LIKE '%.%';
