-- Migration 0008: Fix RLS ops role check across all tables
--
-- Problem: All ops_all policies check (auth.jwt() ->> 'role') = 'ops', but Supabase's
-- JWT always has role = 'authenticated' at the top level. Custom roles live in
-- app_metadata. The custom_access_token_hook that injected a top-level 'role' claim
-- was removed, so all ops_all policies are silently failing — ops users have no write
-- access to any table.
--
-- Fix: Create a helper function public.is_ops() that checks BOTH locations (top-level
-- role claim AND app_metadata.role), so it works whether or not the hook is later
-- re-enabled. Then recreate every ops_all policy to use it.
--
-- After applying this migration:
--   For each ops user, go to Supabase Auth dashboard → Users → Edit user →
--   set app_metadata.role = 'ops'
--   (or use the Supabase admin API: supabase.auth.admin.updateUserById(id, { app_metadata: { role: 'ops' } }))

-- ============================================================
-- PART 1: Create is_ops() helper function
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_ops() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT
    (auth.jwt() ->> 'role') = 'ops'
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'ops'
$$;

GRANT EXECUTE ON FUNCTION public.is_ops() TO authenticated;

-- ============================================================
-- PART 2: Recreate ops_all policies on orchestration schema tables
-- ============================================================

-- orchestration.orchestrations
DROP POLICY IF EXISTS "ops_all" ON orchestration.orchestrations;
CREATE POLICY "ops_all" ON orchestration.orchestrations
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

-- orchestration.orchestration_access
DROP POLICY IF EXISTS "ops_all" ON orchestration.orchestration_access;
CREATE POLICY "ops_all" ON orchestration.orchestration_access
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

-- orchestration.runs
DROP POLICY IF EXISTS "ops_all" ON orchestration.runs;
CREATE POLICY "ops_all" ON orchestration.runs
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

-- orchestration.run_steps
DROP POLICY IF EXISTS "ops_all" ON orchestration.run_steps;
CREATE POLICY "ops_all" ON orchestration.run_steps
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

-- orchestration.tool_calls
DROP POLICY IF EXISTS "ops_all" ON orchestration.tool_calls;
CREATE POLICY "ops_all" ON orchestration.tool_calls
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

-- orchestration.artifacts
DROP POLICY IF EXISTS "ops_all" ON orchestration.artifacts;
CREATE POLICY "ops_all" ON orchestration.artifacts
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

-- orchestration.approvals
DROP POLICY IF EXISTS "ops_all" ON orchestration.approvals;
CREATE POLICY "ops_all" ON orchestration.approvals
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

-- ============================================================
-- PART 3: Recreate ops_all policies on public schema tables
-- ============================================================

-- GovCon / Business Development tables

DROP POLICY IF EXISTS "ops_all" ON public.opportunities;
CREATE POLICY "ops_all" ON public.opportunities
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.opportunity_documents;
CREATE POLICY "ops_all" ON public.opportunity_documents
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.opportunity_documents_vt;
CREATE POLICY "ops_all" ON public.opportunity_documents_vt
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.assessments;
CREATE POLICY "ops_all" ON public.assessments
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.capability_statements;
CREATE POLICY "ops_all" ON public.capability_statements
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.company_profiles;
CREATE POLICY "ops_all" ON public.company_profiles
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.past_performance;
CREATE POLICY "ops_all" ON public.past_performance
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.past_performance_vt;
CREATE POLICY "ops_all" ON public.past_performance_vt
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.icp_profiles;
CREATE POLICY "ops_all" ON public.icp_profiles
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.incumbent_research;
CREATE POLICY "ops_all" ON public.incumbent_research
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.prompt_bank;
CREATE POLICY "ops_all" ON public.prompt_bank
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

-- Finance tables

DROP POLICY IF EXISTS "ops_all" ON public.contracts;
CREATE POLICY "ops_all" ON public.contracts
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.budget_lines;
CREATE POLICY "ops_all" ON public.budget_lines
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.invoices;
CREATE POLICY "ops_all" ON public.invoices
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.labor_records;
CREATE POLICY "ops_all" ON public.labor_records
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.indirect_rates;
CREATE POLICY "ops_all" ON public.indirect_rates
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

-- Resume / Recruiting tables

DROP POLICY IF EXISTS "ops_all" ON public.candidates;
CREATE POLICY "ops_all" ON public.candidates
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.resume_jobs;
CREATE POLICY "ops_all" ON public.resume_jobs
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.resume_queue;
CREATE POLICY "ops_all" ON public.resume_queue
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.resume_results;
CREATE POLICY "ops_all" ON public.resume_results
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

-- HR / Employee tables

DROP POLICY IF EXISTS "ops_all" ON public.employees;
CREATE POLICY "ops_all" ON public.employees
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

DROP POLICY IF EXISTS "ops_all" ON public.staff_requests;
CREATE POLICY "ops_all" ON public.staff_requests
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

-- Analyst uploads (from migration 0007)

DROP POLICY IF EXISTS "ops_all" ON public.analyst_uploads;
CREATE POLICY "ops_all" ON public.analyst_uploads
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());
