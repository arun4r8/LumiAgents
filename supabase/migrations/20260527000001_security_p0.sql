-- P0 security hardening: lock down the analyst NL→SQL path + add per-user rate limiting.
--
-- Rollback (manual): restore analyst_query from 20260506000003; DROP the rate_limit
-- table/RPC; DROP ROLE analyst_ro (after REVOKEing its grants).

-- ─── 1. Least-privilege role for analyst-generated SQL ──────────────────────────
-- The analyst RPC is SECURITY DEFINER (owner ~ superuser), so a crafted SELECT could
-- otherwise read auth.users / vault / any table (RLS doesn't apply to the definer).
-- Run the generated query as a role that can ONLY SELECT the analytics tables.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analyst_ro') THEN
    CREATE ROLE analyst_ro NOLOGIN;
  END IF;
END $$;

-- BYPASSRLS: the analytics tables are RLS-protected (ops-only). analyst_ro is
-- neither an ops JWT nor service_role, so without this every query returns zero
-- rows. Table-level GRANT below still restricts WHICH tables it can read, so
-- auth.users / vault / storage / orchestration internals stay unreadable.
ALTER ROLE analyst_ro BYPASSRLS;

GRANT USAGE ON SCHEMA public TO analyst_ro;
GRANT SELECT ON
  public.opportunities, public.assessments, public.contracts, public.budget_lines,
  public.invoices, public.labor_records, public.indirect_rates, public.employees,
  public.candidates, public.resume_results, public.resume_jobs, public.past_performance,
  public.analyst_uploads
TO analyst_ro;

-- The SECURITY DEFINER owner must be a member of analyst_ro to SET ROLE to it.
GRANT analyst_ro TO postgres;

CREATE OR REPLACE FUNCTION orchestration.analyst_query(query_sql text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  result     jsonb;
  normalized text;
BEGIN
  normalized := upper(trim(regexp_replace(query_sql, '^(\s|--[^\n]*\n)*', '', 'g')));

  IF normalized !~ '^SELECT\s' THEN
    RAISE EXCEPTION 'analyst_query only allows SELECT statements, got: %', left(normalized, 40);
  END IF;
  IF normalized ~* '(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|EXECUTE|COPY|DO\s)' THEN
    RAISE EXCEPTION 'analyst_query: forbidden keyword detected';
  END IF;

  -- Defense in depth: bounded time, read-only, and least-privilege role for the
  -- duration of this statement. SET LOCAL auto-resets at transaction end.
  SET LOCAL statement_timeout = '5s';
  SET LOCAL transaction_read_only = on;
  SET LOCAL ROLE analyst_ro;

  EXECUTE format('SELECT jsonb_agg(t) FROM (%s) t', query_sql) INTO result;
  RETURN COALESCE(result, '[]'::jsonb);
END;
$function$;

-- ─── 2. Per-user rate limiting (fixed window) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rate_limit (
  user_id      text        NOT NULL,
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, bucket, window_start)
);

ALTER TABLE public.rate_limit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_read_rate_limit" ON public.rate_limit
  FOR SELECT TO authenticated USING (public.is_ops());
GRANT ALL ON public.rate_limit TO service_role;

-- Claim one unit of a user's quota for a bucket. Returns TRUE if within p_limit
-- for the current fixed window of p_window_seconds, FALSE if over.
CREATE OR REPLACE FUNCTION public.claim_rate_limit(
  p_user text, p_bucket text, p_limit integer, p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window timestamptz;
  v_count  integer;
BEGIN
  v_window := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  INSERT INTO public.rate_limit (user_id, bucket, window_start, count)
  VALUES (p_user, p_bucket, v_window, 1)
  ON CONFLICT (user_id, bucket, window_start) DO UPDATE SET count = rate_limit.count + 1
  RETURNING count INTO v_count;
  RETURN v_count <= p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_rate_limit(text, text, integer, integer) TO service_role;
