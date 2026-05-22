-- Migration: make resume_jobs.user_id nullable
--
-- The resume_jobs table was originally built for the old frontend which used
-- integer user IDs. The new LumiAgents platform uses Supabase UUID users and
-- does not send a userId to the n8n webhook — so user_id is always null on
-- every inbound request. Keeping the NOT NULL constraint causes every job
-- creation to fail with a DB error before any scoring can start.
--
-- user_id is not read by any of our code paths (bump_job_progress, claim_resume_queue)
-- so dropping the constraint has no functional impact.
--
-- Rollback:
--   ALTER TABLE public.resume_jobs ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE public.resume_jobs
  ALTER COLUMN user_id DROP NOT NULL;
