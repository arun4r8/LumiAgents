-- ============================================================================
-- Pipeline stage: which column of the board an opportunity sits in.
--
-- From the LumiAgents BD Figma and the 2026-09-01 syncup: a Kanban board whose
-- columns are the Bid-phase stages, one card per opportunity, moved between
-- columns to trigger the next piece of work.
--
-- SEPARATE FROM `disposition`, which is the triage decision (pursue / watch /
-- ignore). Disposition answers "are we doing this at all"; stage answers "how far
-- along is it". Only a 'pursue' opportunity is on the board.
--
-- SEPARATE FROM `status`, which is the solicitation's own state and which the
-- sweep hardcodes to 'open'.
--
-- Stage names are snake_case versions of the Figma column headings, kept in the
-- design's order. `stage_order()` exists so the UI, the queries and any future
-- automation agree on that order in one place rather than three.
-- ============================================================================

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS pipeline_stage    text,
  ADD COLUMN IF NOT EXISTS pipeline_stage_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'opportunities'
      AND c.conname = 'opportunities_pipeline_stage_check'
  ) THEN
    EXECUTE $c$
      ALTER TABLE public.opportunities
        ADD CONSTRAINT opportunities_pipeline_stage_check
        CHECK (pipeline_stage IS NULL OR pipeline_stage IN (
          'response_outline',
          'past_performance',
          'reqs_reps_certs',
          'pricing',
          'negotiate_mobilize'
        ))
    $c$;
  END IF;
END $$;

-- The board reads "pursue, grouped by stage"; both columns are selective.
CREATE INDEX IF NOT EXISTS opportunities_pipeline_stage_idx
  ON public.opportunities (disposition, pipeline_stage);

COMMENT ON COLUMN public.opportunities.pipeline_stage IS
  'Board column: response_outline | past_performance | reqs_reps_certs | pricing | negotiate_mobilize. NULL means not yet placed; a pursued opportunity with NULL renders in the first column. Distinct from `disposition` (whether we are doing it) and `status` (the solicitation''s own state).';
COMMENT ON COLUMN public.opportunities.pipeline_stage_at IS
  'When the card last moved. The board sorts stalled cards to the top, so this is what makes "nothing has happened here in three weeks" visible.';
