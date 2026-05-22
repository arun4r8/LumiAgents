-- Migration: fix claim_resume_queue — wrong status filter
--
-- The function was filtering for status = 'pending' but n8n's
-- "Add to Process Queue" node inserts rows with status = 'queued'.
-- This caused claim_resume_queue to always return empty, so the
-- Worker Retrieval section never processed any resumes.
--
-- Fix: change the WHERE filter from 'pending' → 'queued'.
--
-- Rollback:
--   Replace 'queued' back to 'pending' in the WHERE clause below.

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
    WHERE  status = 'queued'
      AND  locked_at IS NULL
    ORDER  BY created_at
    LIMIT  p_limit
    FOR    UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_resume_queue(int, text) TO service_role;
