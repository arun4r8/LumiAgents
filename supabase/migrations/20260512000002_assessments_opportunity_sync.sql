-- Migration: sync assessment scores back to opportunities
--
-- The opportunities table has fit_score, recommendation, and last_scored_at
-- columns that were originally written by the Workers v2 beady/govcon-assessment
-- orchestration (now deleted). The n8n GovCon Qualification Assessment Workflows
-- flow writes to public.assessments instead, so those columns were becoming stale.
--
-- This trigger fires after each INSERT or UPDATE on assessments and backfills the
-- three quick-lookup columns on opportunities so the dashboard can filter/sort
-- opportunities by score without joining to assessments.
--
-- Mapping:
--   assessments.weighted_score (0–100)   → opportunities.fit_score (1–10)
--   assessments.go_no_go                 → opportunities.recommendation
--     'go'          → 'pursue'
--     'no-go'       → 'pass'
--     'conditional' → 'monitor'
--
-- fit_reason and red_flags are NOT synced here — the assessments table does not
-- store a short justification string. Those columns remain available for manual
-- entry or a future n8n node update.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS assessments_sync_opportunity ON public.assessments;
--   DROP FUNCTION IF EXISTS public.sync_assessment_to_opportunity();

CREATE OR REPLACE FUNCTION public.sync_assessment_to_opportunity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.opportunities
  SET
    fit_score      = CASE
                       WHEN NEW.weighted_score IS NULL THEN NULL
                       ELSE LEAST(10, GREATEST(1, ROUND(NEW.weighted_score / 10.0)::smallint))
                     END,
    recommendation = CASE NEW.go_no_go
                       WHEN 'go'          THEN 'pursue'
                       WHEN 'no-go'       THEN 'pass'
                       WHEN 'conditional' THEN 'monitor'
                       ELSE NULL
                     END,
    last_scored_at = NOW()
  WHERE id = NEW.opportunity_id;

  RETURN NEW;
END;
$$;

-- Ops and service_role can invoke this trigger function indirectly via INSERT/UPDATE.
-- No direct GRANT needed — SECURITY DEFINER runs as the function owner.

DROP TRIGGER IF EXISTS assessments_sync_opportunity ON public.assessments;

CREATE TRIGGER assessments_sync_opportunity
  AFTER INSERT OR UPDATE OF weighted_score, go_no_go
  ON public.assessments
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_assessment_to_opportunity();
