-- Migration: add govcon_assessments table
--
-- What changes:
--   Adds a govcon_assessments table to store the full output of each
--   beady/govcon-assessment run — score, go/no-go, exec memo, and per-factor
--   scoring breakdown. One row per orchestration run so assessment history is
--   preserved. Previously all assessment logic lived inside n8n with no DB
--   record; this migration is part of migrating that logic into the runtime.
--
-- Migration story for in-flight runs:
--   No impact. The table is new; existing runs (all via n8n) never wrote here.
--   The n8n flow will keep running until the orchestration definition is
--   switched over in the same PR.
--
-- Rollback (manual, do not run automatically):
--   DROP TABLE IF EXISTS public.govcon_assessments;

BEGIN;

CREATE TABLE IF NOT EXISTS public.govcon_assessments (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id   uuid         NOT NULL
                                REFERENCES public.opportunities(id)
                                ON DELETE CASCADE,
  run_id           text,                                         -- orchestration run that produced this assessment
  score            smallint     CHECK (score BETWEEN 0 AND 100),
  go_no_go         text         CHECK (go_no_go IN ('go', 'no-go', 'conditional')),
  executive_memo   text,
  scoring_factors  jsonb,                                        -- structured breakdown: { "technical_fit": {...}, "past_performance": {...}, ... }
  requires_review  boolean      NOT NULL DEFAULT false,
  notes            text,                                         -- operator notes passed at trigger time
  created_at       timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS govcon_assessments_opportunity_id_idx
  ON public.govcon_assessments (opportunity_id);

CREATE INDEX IF NOT EXISTS govcon_assessments_created_at_idx
  ON public.govcon_assessments (created_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.govcon_assessments ENABLE ROW LEVEL SECURITY;

-- Ops users have full access (read + write via service role; read via dashboard)
CREATE POLICY govcon_assessments_ops_all ON public.govcon_assessments
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

-- End users have no direct access to assessments (ops-internal data)
-- No enduser policy intentional: assessment scores and memos are ops-only.

COMMIT;
