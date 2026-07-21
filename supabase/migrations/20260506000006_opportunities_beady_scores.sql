-- Migration: 0006_opportunities_beady_scores
-- Adds Beady's scoring columns to public.opportunities.
--
-- The table and its "ops_all" RLS policy were established in 0004.
-- No new RLS policy is needed: the existing policy covers all columns.
--
-- Rollback: DROP COLUMN for each column added below (data loss accepted).

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS fit_score       smallint   CHECK (fit_score BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS fit_reason      text,
  ADD COLUMN IF NOT EXISTS red_flags       text,
  ADD COLUMN IF NOT EXISTS recommendation  text       CHECK (recommendation IN ('pursue', 'monitor', 'pass')),
  ADD COLUMN IF NOT EXISTS last_scored_at  timestamptz;

COMMENT ON COLUMN public.opportunities.fit_score       IS 'Beady 1-10 fit score for Lumiture (null = not yet scored)';
COMMENT ON COLUMN public.opportunities.fit_reason      IS 'One-to-two sentence justification from Beady';
COMMENT ON COLUMN public.opportunities.red_flags       IS 'Any concerns surfaced by Beady (clearance, incumbent, size, etc.)';
COMMENT ON COLUMN public.opportunities.recommendation  IS 'pursue | monitor | pass; set by Beady';
COMMENT ON COLUMN public.opportunities.last_scored_at  IS 'Timestamp of the most recent Beady scoring pass';
