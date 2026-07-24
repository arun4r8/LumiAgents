-- 2026-07 audit housekeeping: drop deprecated/orphaned objects (approved).
-- Part of the audit-driven cleanup sweep (#83).
--
-- Dropped:
--   * orchestration.report_subscriptions, orchestration.award_subscriptions
--       Superseded by the unified orchestration.subscriptions (kind discriminator);
--       kept until now only as a rollback net.
--   * public.n8n_call_queue + public.claim_n8n_calls(int)
--       The n8n drainer is disabled (gated behind N8N_QUEUE_ENABLED) and nothing enqueues.
--   * public.opportunity_documents_vt, public.past_performance_vt + their match_*_vt RPCs
--       Dormant Google-Gemini (3072-dim) vector stores, empty and unused since RAG moved
--       to Workers-AI bge on document_chunks (see the note in 20260525000001).
--
-- Also removes any lingering schedule for the retired beady/opportunity-search and
-- beady/sbir-topic-search orchestrations (code deleted in PR #86) so the meta-cron
-- never tries to dispatch a missing orchestration.

-- 1) Deprecated subscription rollback tables
DROP TABLE IF EXISTS orchestration.report_subscriptions CASCADE;
DROP TABLE IF EXISTS orchestration.award_subscriptions CASCADE;

-- 2) n8n call queue + its claim function
DROP FUNCTION IF EXISTS public.claim_n8n_calls(int);
DROP TABLE IF EXISTS public.n8n_call_queue CASCADE;

-- 3) Dormant Gemini vector stores + their manually-created match_*_vt RPCs.
--    Functions were created out-of-band (not in migrations), so drop by name pattern.
--    The regex requires a _vt suffix, so the live match_document_chunks is untouched.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE proname ~ '^match_.*_vt$' LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig || ' CASCADE';
  END LOOP;
END $$;
DROP TABLE IF EXISTS public.opportunity_documents_vt CASCADE;
DROP TABLE IF EXISTS public.past_performance_vt CASCADE;

-- 4) Retire schedules for the removed search orchestrations (PR #86). No-op if absent.
DELETE FROM orchestration.schedules
  WHERE orchestration_name IN ('beady/opportunity-search', 'beady/sbir-topic-search');
