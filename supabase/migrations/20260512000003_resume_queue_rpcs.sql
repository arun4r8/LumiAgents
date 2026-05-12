-- Migration: capture resume queue RPC functions
--
-- These two functions were created manually in Supabase (not through migrations)
-- and are called by the n8n Resume Scoring Workflow. This migration captures them
-- so the schema can be rebuilt cleanly from migrations alone.
--
-- claim_resume_queue   — atomically claims up to p_limit pending queue items for a
--                        named worker, preventing double-processing under concurrency.
--                        Called by n8n: POST /rest/v1/rpc/claim_resume_queue
--                        with body { p_limit: 25, p_worker: "worker-1" }
--
-- bump_job_progress    — increments the processed counter on a resume_job row and
--                        marks the job 'done' when processed reaches total.
--                        Called by n8n: POST /rest/v1/rpc/bump_job_progress
--                        with body { p_job_id: "<uuid>" }
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.claim_resume_queue(int, text);
--   DROP FUNCTION IF EXISTS public.bump_job_progress(uuid);

CREATE OR REPLACE FUNCTION public.claim_resume_queue(
  p_limit  int  DEFAULT 10,
  p_worker text DEFAULT 'worker'
)
RETURNS SETOF public.resume_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.resume_queue
  SET
    status    = 'processing',
    locked_at = NOW(),
    locked_by = p_worker
  WHERE id IN (
    SELECT id
    FROM   public.resume_queue
    WHERE  status = 'pending'
      AND  locked_at IS NULL
    ORDER  BY created_at
    LIMIT  p_limit
    FOR    UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_resume_queue(int, text) TO service_role;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bump_job_progress(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.resume_jobs
  SET
    processed = processed + 1,
    status    = CASE
                  WHEN processed + 1 >= total THEN 'done'
                  ELSE status
                END
  WHERE id = p_job_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bump_job_progress(uuid) TO service_role;
