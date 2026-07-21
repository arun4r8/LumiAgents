-- Migration: drop govcon_assessments
--
-- The govcon_assessments table was created for the Workers v2 beady/govcon-assessment
-- orchestration, which has been removed in favour of keeping the n8n GovCon
-- Qualification Assessment Workflows flow as the authoritative implementation.
-- n8n writes to public.assessments instead.
--
-- This table had no production writes; it was only ever written to by the now-deleted
-- Workers v2 orchestration.
--
-- Rollback: re-run supabase/migrations/202605080911_govcon_assessments.sql

BEGIN;
DROP TABLE IF EXISTS public.govcon_assessments;
COMMIT;
