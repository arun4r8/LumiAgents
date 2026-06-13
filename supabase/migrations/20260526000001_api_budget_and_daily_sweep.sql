-- Per-source daily API budget guard + switch the daily opportunity scan to the
-- SAM.gov + SBIR sweep.
--
-- Rollback (manual):
--   DROP FUNCTION IF EXISTS public.claim_api_budget(text, integer);
--   DROP TABLE IF EXISTS public.api_budget;
--   UPDATE orchestration.schedules SET orchestration_name='beady/opportunity-search',
--     label='Daily opportunity scan' WHERE orchestration_name='beady/opportunity-sweep';

-- 1. Daily call counter per external source. One row per (source, day); doubles as
--    the queryable per-source volume metric.
CREATE TABLE IF NOT EXISTS public.api_budget (
  source text        NOT NULL,
  day    date        NOT NULL DEFAULT current_date,
  count  integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (source, day)
);

ALTER TABLE public.api_budget ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_read_api_budget" ON public.api_budget
  FOR SELECT TO authenticated
  USING (public.is_ops());

GRANT ALL ON public.api_budget TO service_role;

-- 2. Atomically claim one unit of the day's budget for a source.
--    Returns TRUE if the post-increment count is within p_limit, FALSE if over.
CREATE OR REPLACE FUNCTION public.claim_api_budget(p_source text, p_limit integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.api_budget (source, day, count)
  VALUES (p_source, current_date, 1)
  ON CONFLICT (source, day) DO UPDATE SET count = api_budget.count + 1
  RETURNING count INTO v_count;
  RETURN v_count <= p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_api_budget(text, integer) TO service_role;

-- 3. Daily scan now runs the combined SAM.gov + SBIR sweep (one LLM pass), with
--    pre-scoring dedupe handled in the orchestration.
UPDATE orchestration.schedules
SET orchestration_name = 'beady/opportunity-sweep',
    label             = 'Daily opportunity sweep (SAM.gov + SBIR)',
    default_input     = '{}'::jsonb,
    updated_at        = now()
WHERE orchestration_name = 'beady/opportunity-search';
