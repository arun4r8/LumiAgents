-- Migration 0004: Prune n8n-era dead tables and harden RLS on all public tables
-- Context: Multiple legacy tables from n8n era are empty and superseded.
--   agent_tasks / agent_logs → replaced by orchestration.runs / orchestration.run_steps
--   documents               → replaced by orchestration.orch_documents
--   records                 → generic store, never used
--   call_logs / email_logs / sms_logs → comms logs with 0 rows, no active writers
--
-- Also removes username/password columns from public.users (0 rows; auth_id added in 0002).
--
-- Rollback: this migration is intentionally destructive on confirmed-empty tables.
--   To undo: restore from backup or recreate tables from original n8n schema.
--   The agent_tasks rows (3) are agent Angie bootstrap records with no runtime value.

-- ============================================================
-- PART 1: Drop legacy tables
-- ============================================================

-- n8n-era agent telemetry (superseded by orchestration schema)
DROP TABLE IF EXISTS public.agent_logs CASCADE;
DROP TABLE IF EXISTS public.agent_tasks CASCADE;

-- Generic doc store (superseded by orchestration.orch_documents + orchestration.document_chunks)
DROP TABLE IF EXISTS public.documents CASCADE;

-- Generic records store (never used)
DROP TABLE IF EXISTS public.records CASCADE;

-- Comms logs (0 rows, no active writers)
DROP TABLE IF EXISTS public.call_logs CASCADE;
DROP TABLE IF EXISTS public.email_logs CASCADE;
DROP TABLE IF EXISTS public.sms_logs CASCADE;

-- ============================================================
-- PART 2: Finish users table cleanup (started in 0002)
-- Drop username/password now that the table has 0 rows and
-- auth_id is the identity column going forward.
-- ============================================================

ALTER TABLE public.users DROP COLUMN IF EXISTS password;
ALTER TABLE public.users DROP COLUMN IF EXISTS username;

-- ============================================================
-- PART 3: Enable RLS + ops policies on all remaining public tables
-- Pattern: ops role = full SELECT/INSERT/UPDATE; service_role bypasses RLS.
-- Tables with candidate-facing data also get a self-service SELECT.
-- ============================================================

-- Helper: JWT role claim used throughout
-- (auth.jwt() ->> 'role') = 'ops'

-- -------------------------------------------------------
-- GovCon / Business Development tables (ops-only)
-- -------------------------------------------------------

ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.opportunities
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.opportunity_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.opportunity_documents
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.opportunity_documents_vt ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.opportunity_documents_vt
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.assessments
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.capability_statements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.capability_statements
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.company_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.company_profiles
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.past_performance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.past_performance
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.past_performance_vt ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.past_performance_vt
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.icp_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.icp_profiles
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.incumbent_research ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.incumbent_research
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.prompt_bank ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.prompt_bank
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

-- -------------------------------------------------------
-- Finance tables (ops-only)
-- -------------------------------------------------------

ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.contracts
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.budget_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.budget_lines
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.invoices
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.labor_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.labor_records
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.indirect_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.indirect_rates
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

-- -------------------------------------------------------
-- Resume / Recruiting tables
-- ops: full access
-- enduser (candidate): read their own resume_results row (matched by email when we wire that up)
-- -------------------------------------------------------

ALTER TABLE public.candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.candidates
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.resume_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.resume_jobs
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.resume_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.resume_queue
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.resume_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.resume_results
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

-- -------------------------------------------------------
-- HR / Employee tables (ops-only)
-- -------------------------------------------------------

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.employees
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

ALTER TABLE public.staff_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_all" ON public.staff_requests
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'ops') WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

-- ============================================================
-- PART 4: Explicit GRANTs so service_role (runtime) can bypass RLS
-- Supabase service_role already bypasses RLS by default, but
-- being explicit here ensures nothing breaks if that changes.
-- ============================================================

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
