-- Cleo RFI drafting: store generated Sources Sought / RFI responses. The
-- cleo/rfi-draft orchestration (agent-triggered) writes here; the dashboard reads
-- it. Grounded in company_profiles + past_performance.
--
-- Rollback:
--   DROP TABLE public.rfi_drafts;
--   DELETE FROM orchestration.orchestrations WHERE name='cleo/rfi-draft';

CREATE TABLE IF NOT EXISTS public.rfi_drafts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sam_notice_id     text,
  opportunity_title text,
  agency            text,
  notice_type       text,
  response_deadline text,
  draft_markdown    text        NOT NULL,
  model             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rfi_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all_rfi_drafts" ON public.rfi_drafts
  FOR ALL TO authenticated
  USING (public.is_ops()) WITH CHECK (public.is_ops());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rfi_drafts TO authenticated;
GRANT ALL ON public.rfi_drafts TO service_role;

-- Register the orchestration (agent-triggered / on-demand — no schedule).
INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES ('cleo/rfi-draft', 1,
  'Draft a Sources Sought / RFI response for an opportunity, grounded in Lumiture''s profile and past performance.',
  '{}', '{}', true, 'agent')
ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;
