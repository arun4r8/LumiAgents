-- Restrict public.list_orchestration_tables() to the service role, which is what
-- 20260805000002_agent_proposals.sql intended and did not achieve.
--
-- That migration granted EXECUTE to service_role and stopped there. Two things
-- then hand it to everyone anyway:
--
--   1. Postgres grants EXECUTE on a new function to PUBLIC by default. A GRANT to
--      one role does not revoke that.
--   2. This project has ALTER DEFAULT PRIVILEGES on the public schema granting
--      EXECUTE on functions to anon and authenticated
--      (20260513000003_default_privileges_public.sql).
--
-- The observed ACL on staging, where it is already live:
--   =X/postgres | postgres=X | anon=X | authenticated=X | service_role=X
--
-- Because config.toml exposes the public schema through PostgREST, the function
-- is reachable unauthenticated at POST /rest/v1/rpc/list_orchestration_tables
-- with the publishable anon key. Confirmed against staging: HTTP 200 and the full
-- list of orchestration-schema table names.
--
-- Blast radius is names only. It is SECURITY DEFINER but reads nothing but
-- pg_class, and the table grants are unaffected -- reading any of those tables as
-- anon still fails with 42501. So this is unintended schema disclosure, not data
-- exposure. Fixed before it reaches production rather than after.
--
-- Also pins search_path as pg_catalog first. The original put public ahead of
-- pg_catalog, so the unqualified pg_class / pg_namespace references resolved
-- against public first. Not exploitable today (PUBLIC has USAGE but not CREATE on
-- the public schema, so nobody can plant a shadowing relation), but it is one
-- grant away from mattering, and public.rls_auto_enable already uses the safe
-- order.

BEGIN;

CREATE OR REPLACE FUNCTION public.list_orchestration_tables()
RETURNS TABLE (table_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'orchestration'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  ORDER BY 1;
$$;

-- Order matters: REVOKE the default grants first, then grant back only the role
-- that should have it. Revoking from PUBLIC does not remove the explicit anon /
-- authenticated grants, so all three are named.
REVOKE EXECUTE ON FUNCTION public.list_orchestration_tables() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_orchestration_tables() FROM anon;
REVOKE EXECUTE ON FUNCTION public.list_orchestration_tables() FROM authenticated;

GRANT EXECUTE ON FUNCTION public.list_orchestration_tables() TO service_role;

COMMIT;
