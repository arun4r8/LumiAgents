-- Hybrid RFI workflow: analyze -> (intake gate only when material gaps) -> draft ->
-- adversarial assess -> revise. Adapted from the solicitation-response skill.
--
-- The gate is conditional: when the analysis judges the reference material sufficient
-- to draft accurately, we go straight to drafting. When it finds material gaps, we stop
-- and surface an intake (questions/gaps/fit matrix) for a human to answer first, which
-- is what keeps unconfirmed claims out of a federal submission.
--
-- Rollback:
--   ALTER TABLE public.rfi_drafts
--     DROP COLUMN status, DROP COLUMN analysis, DROP COLUMN intake,
--     DROP COLUMN answers, DROP COLUMN assessment;

ALTER TABLE public.rfi_drafts
  ADD COLUMN IF NOT EXISTS status     text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('intake', 'drafting', 'ready')),
  -- Phase 1: required-content list, risk flags, sufficiency verdict, technical-approach analysis
  ADD COLUMN IF NOT EXISTS analysis   jsonb,
  -- Phase 2: questions / gaps / experience-fit matrix shown to the user when gated
  ADD COLUMN IF NOT EXISTS intake     jsonb,
  -- Phase 3: the user's answers, fed back into drafting
  ADD COLUMN IF NOT EXISTS answers    jsonb,
  -- Phase 5: compliance + evaluation-factor + accuracy assessment of the draft
  ADD COLUMN IF NOT EXISTS assessment jsonb;

-- draft_markdown is empty while a row is waiting at the intake gate.
ALTER TABLE public.rfi_drafts ALTER COLUMN draft_markdown DROP NOT NULL;

CREATE INDEX IF NOT EXISTS rfi_drafts_status_idx ON public.rfi_drafts (status);
