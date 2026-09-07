-- ============================================================================
-- claim_api_budget(source, limit, units) -- claim several calls in one round trip
--
-- WHY
--   The single-unit version costs one Supabase round trip per external call. That
--   is fine when an integration makes one call per run, and expensive when it
--   pages: SAM.gov's paged walk claimed once per page, so a sweep spent 7 of its
--   50-subrequest Worker budget on budget accounting alone.
--
--   Cloudflare allows 50 subrequests per Worker invocation and a Workflow spends
--   that across the whole orchestration, so a round trip whose only job is to
--   increment a counter is a round trip competing with real work.
--
-- SEMANTICS
--   Increments by `p_units` and returns whether the day's total is still within
--   `p_limit`. Callers claim an UPPER BOUND before paging and may use fewer; the
--   counter therefore over-counts slightly rather than under-counting, which is the
--   right direction for a quota that exists to avoid a 429 from the provider.
--
--   The single-argument form is kept, delegating with p_units => 1, so existing
--   callers are untouched. Note this is an OVERLOAD, not a replacement: PostgREST
--   resolves the two by argument name, so both signatures must keep their grants.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claim_api_budget(p_source text, p_limit integer, p_units integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_units < 1 THEN
    RAISE EXCEPTION 'claim_api_budget: p_units must be >= 1, got %', p_units;
  END IF;

  INSERT INTO public.api_budget (source, day, count)
  VALUES (p_source, current_date, p_units)
  ON CONFLICT (source, day) DO UPDATE SET count = api_budget.count + p_units
  RETURNING count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_api_budget(text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.claim_api_budget(text, integer, integer) IS
  'Atomically claim p_units of a source''s daily API budget. Returns false once the day''s total exceeds p_limit. Callers that page should claim an upper bound once rather than one unit per page: on Cloudflare Workers each claim is a subrequest against a 50-per-invocation ceiling.';
