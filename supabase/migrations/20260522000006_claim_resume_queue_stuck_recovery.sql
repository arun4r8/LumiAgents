-- Migration: claim_resume_queue — recover items stuck in 'processing'
--
-- If an n8n Worker execution crashes mid-batch, claimed items remain in
-- 'processing' with locked_at set but never advance to 'done'. The old
-- function required locked_at IS NULL, so crashed items were lost forever.
--
-- Fix: at the start of each claim call, reset any items that have been
-- processing for more than 10 minutes back to 'queued' so they can be
-- re-claimed on the next Worker tick.
--
-- Rollback:
--   Revert to the version in 20260522000004_fix_claim_resume_queue_status.sql

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
  -- Reset items stuck in processing for more than 10 minutes.
  UPDATE public.resume_queue
  SET
    status    = 'queued',
    locked_at = NULL,
    locked_by = NULL
  WHERE status    = 'processing'
    AND locked_at < NOW() - INTERVAL '10 minutes';

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
