-- Migration: n8n_call_queue — app-side queue for n8n webhook calls
--
-- Any orchestration can push a JSON webhook call here instead of calling n8n
-- directly. The cron drainer in runtime/src/utils/n8n-queue-drainer.ts fires
-- up to 5 pending calls per tick, keeping us within n8n's concurrency cap.
-- Binary payloads must be uploaded to Storage first; pass the path as JSON.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.n8n_call_queue;
--   DROP FUNCTION IF EXISTS public.claim_n8n_calls(int);

CREATE TABLE public.n8n_call_queue (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_path text        NOT NULL,
  payload      jsonb       NOT NULL DEFAULT '{}',
  status       text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts     int         NOT NULL DEFAULT 0,
  max_attempts int         NOT NULL DEFAULT 3,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz
);

CREATE INDEX n8n_call_queue_pending_idx ON public.n8n_call_queue(created_at)
  WHERE status = 'pending';

ALTER TABLE public.n8n_call_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON public.n8n_call_queue
  FOR ALL TO authenticated
  USING  (public.is_ops())
  WITH CHECK (public.is_ops());

GRANT ALL ON public.n8n_call_queue TO service_role;

-- Atomically claim up to p_limit pending calls. SKIP LOCKED prevents two cron
-- ticks from firing the same call if the cron overlaps.
CREATE OR REPLACE FUNCTION public.claim_n8n_calls(p_limit int DEFAULT 5)
RETURNS SETOF public.n8n_call_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.n8n_call_queue
  SET
    status       = 'processing',
    attempts     = attempts + 1,
    attempted_at = NOW()
  WHERE id IN (
    SELECT id
    FROM   public.n8n_call_queue
    WHERE  status = 'pending'
      AND  attempts < max_attempts
    ORDER  BY created_at
    LIMIT  p_limit
    FOR    UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_n8n_calls(int) TO service_role;
