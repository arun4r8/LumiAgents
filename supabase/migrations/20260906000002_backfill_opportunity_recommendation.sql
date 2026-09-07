-- ============================================================================
-- Backfill opportunities.recommendation from fit_score
--
-- Two rows in production carry a fit_score (2 and 3) with recommendation NULL:
--   fa0630b5...  Enterprise Artificial Intelligence (AI) Strategy
--   f31568464... RFI - Analyzing Digital Channels - USPS OIG
--
-- #206 read that as "the minScore threshold is not enforced on every write path".
-- It isn't quite that. Nothing in the current codebase writes fit_score to this
-- table except the sweep, and the sweep cannot produce this shape; both rows
-- predate the current scoring path. They are residue, not a live leak.
--
-- They still leave the column partial, and a partial column invites a reader to
-- treat NULL as a value. `recommendation` is now derived from `fit_score` in the
-- sweep (pursue >= 7, monitor 5-6, pass <= 4), so applying that same rule here
-- makes the column total without inventing anything: the score already said it.
--
-- Scoped to rows where recommendation IS NULL and fit_score IS NOT NULL. A row
-- with no score keeps its NULL, which is the honest answer for "never scored".
-- ============================================================================

UPDATE public.opportunities
SET recommendation = CASE
      WHEN fit_score >= 7 THEN 'pursue'
      WHEN fit_score >= 5 THEN 'monitor'
      ELSE 'pass'
    END
WHERE recommendation IS NULL
  AND fit_score IS NOT NULL;

COMMENT ON COLUMN public.opportunities.recommendation IS
  'Derived from fit_score: pursue >= 7, monitor 5-6, pass <= 4. Not an independent judgement -- it is a band of the score, and the sweep computes it rather than asking the model for it. #197 is where a real second axis (bid/no-bid gates) would go.';
