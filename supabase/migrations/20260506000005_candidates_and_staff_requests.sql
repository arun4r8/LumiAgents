-- Migration 0005: Extend candidates and staff_requests tables for orchestration use
--
-- candidates: add Apollo sourcing columns so angie/candidate-sourcing can upsert cleanly
-- staff_requests: add columns so patch/staff-request can log requests with Jira links
-- opportunities: add columns for SAM.gov data so beady/opportunity-search can store finds
--
-- All three tables are empty (0 rows per audit), so it is safe to add/alter freely.

-- ─── candidates ──────────────────────────────────────────────────────────────

ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS apollo_id       text UNIQUE,
  ADD COLUMN IF NOT EXISTS first_name      text,
  ADD COLUMN IF NOT EXISTS last_name       text,
  ADD COLUMN IF NOT EXISTS current_title   text,
  ADD COLUMN IF NOT EXISTS current_company text,
  ADD COLUMN IF NOT EXISTS linkedin_url    text,
  ADD COLUMN IF NOT EXISTS location        text,
  ADD COLUMN IF NOT EXISTS seniority       text,
  ADD COLUMN IF NOT EXISTS source          text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'apollo', 'linkedin', 'referral')),
  ADD COLUMN IF NOT EXISTS source_run_id   uuid REFERENCES orchestration.runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS match_score     smallint CHECK (match_score BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS match_reason    text,
  ADD COLUMN IF NOT EXISTS outreach_draft  text,
  ADD COLUMN IF NOT EXISTS outreach_sent   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now();

-- updated_at trigger for candidates
CREATE TRIGGER candidates_updated_at
  BEFORE UPDATE ON public.candidates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── staff_requests ───────────────────────────────────────────────────────────

ALTER TABLE public.staff_requests
  ADD COLUMN IF NOT EXISTS title           text,
  ADD COLUMN IF NOT EXISTS request_type    text NOT NULL DEFAULT 'general'
    CHECK (request_type IN ('new_hire', 'backfill', 'contractor', 'general', 'equipment', 'access')),
  ADD COLUMN IF NOT EXISTS description     text,
  ADD COLUMN IF NOT EXISTS requested_by    text,
  ADD COLUMN IF NOT EXISTS priority        text NOT NULL DEFAULT 'Medium'
    CHECK (priority IN ('Highest', 'High', 'Medium', 'Low', 'Lowest')),
  ADD COLUMN IF NOT EXISTS jira_key        text,
  ADD COLUMN IF NOT EXISTS jira_url        text,
  ADD COLUMN IF NOT EXISTS status          text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'approved', 'rejected', 'closed')),
  ADD COLUMN IF NOT EXISTS source_run_id   uuid REFERENCES orchestration.runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER staff_requests_updated_at
  BEFORE UPDATE ON public.staff_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── opportunities (extend for SAM.gov data) ─────────────────────────────────

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS solicitation_number  text UNIQUE,
  ADD COLUMN IF NOT EXISTS sam_notice_id        text UNIQUE,
  ADD COLUMN IF NOT EXISTS agency               text,
  ADD COLUMN IF NOT EXISTS naics_code           text,
  ADD COLUMN IF NOT EXISTS set_aside            text,
  ADD COLUMN IF NOT EXISTS response_deadline    timestamptz,
  ADD COLUMN IF NOT EXISTS posted_date          timestamptz,
  ADD COLUMN IF NOT EXISTS source               text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'sam_gov', 'govcon_api')),
  ADD COLUMN IF NOT EXISTS source_url           text,
  ADD COLUMN IF NOT EXISTS status               text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'awarded', 'cancelled')),
  ADD COLUMN IF NOT EXISTS created_at           timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at           timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER opportunities_updated_at
  BEFORE UPDATE ON public.opportunities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
