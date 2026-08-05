-- Migration: agent_proposals — a pending Tier 2 proposal stops hiding a live agent
-- Issue: #67 (adversarial audit of the merged Tier 0/1/2 code)
--
-- What changes:
--   Tier 2 recorded a pending capability PR by PATCHing the DONOR agent's catalog row to
--   `lifecycle = 'proposed'`. The agents list filters non-ops callers to `lifecycle = 'active'`
--   (dashboard/app/(dashboard)/agents/page.tsx), so proposing a new tool for Cleo removed Cleo
--   from EVERY enduser's Agents page until someone fixed the row by hand. Worse, nothing ever
--   cleared the state: there is no merge webhook and no PR polling, so an agent that entered
--   'proposed' was stranded there.
--
--   A pending proposal is metadata ABOUT an agent, not a statement that the agent stopped
--   working, so it moves into its own table. `orchestration.agent_proposals` records the kind,
--   the target, the PR (number + url + branch) and a status the runtime reconciles against
--   GitHub (open → merged | closed | cancelled). Nothing in the proposal flow writes
--   orchestration.agents any more, so an agent's visibility is untouched by a pending proposal.
--
--   The table also fixes a silent no-op: for kind='agent' the catalog row does not exist until
--   the PR merges, and a PostgREST PATCH matching zero rows returns 204 — so the old code
--   "recorded" nothing at all for the riskiest kind. An INSERT needs no pre-existing row.
--
--   Also adds public.list_orchestration_tables(), so the new-table collision check can ask the
--   REAL schema instead of guessing table names from `*_create_*.sql` migration filenames — a
--   convention no migration in this repo has ever used, which made the check dead code and let
--   a proposal for a table named `agents` or `runs` emit a CREATE POLICY that fails `db push`
--   for the whole project.
--
-- Migration story for in-flight runs:
--   None. New table; nothing reads it yet. The one UPDATE below repairs agents rows that a
--   pre-fix draft left in 'proposed' (they are invisible to endusers today — this un-hides
--   them) and backfills any pending PR recorded on those rows into the new table.
--   agents.pending_pr_url / pending_pr_number are left in place but are now DEPRECATED and
--   unwritten; dropping them is a separate, later migration once nothing reads them.
--
-- Rollback (manual, do not run automatically):
--   DROP FUNCTION IF EXISTS public.list_orchestration_tables();
--   DROP TABLE IF EXISTS orchestration.agent_proposals;

BEGIN;

-- ── The proposal record ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orchestration.agent_proposals (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text        NOT NULL CHECK (kind IN ('orchestration', 'table', 'agent')),
  -- Donor agent (kind='orchestration'), the proposed agent's slug (kind='agent'), or NULL
  -- (kind='table' — a table belongs to no agent). Deliberately NOT a FK: for kind='agent' the
  -- agents row does not exist until the PR merges.
  agent_slug  text,
  -- What is being proposed: capability slug / table name / agent slug.
  target      text,
  pr_number   int         NOT NULL UNIQUE,
  pr_url      text        NOT NULL,
  branch      text,
  status      text        NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'merged', 'closed', 'cancelled')),
  created_by  uuid        REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_proposals_agent_status_idx
  ON orchestration.agent_proposals (agent_slug, status);

-- ── RLS: mirrors orchestration.agents (ops-only; service_role bypasses) ───────

ALTER TABLE orchestration.agent_proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_proposals_ops_all" ON orchestration.agent_proposals
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

GRANT ALL ON orchestration.agent_proposals TO service_role;
GRANT SELECT, INSERT, UPDATE ON orchestration.agent_proposals TO authenticated;

-- ── Backfill + repair ────────────────────────────────────────────────────────
-- Any agent a pre-fix draft pushed into 'proposed' is hidden from endusers right now. Move its
-- pending PR into the new table, then put the agent back to 'active'.

INSERT INTO orchestration.agent_proposals (kind, agent_slug, target, pr_number, pr_url, status)
SELECT 'orchestration', a.slug, a.slug, a.pending_pr_number, a.pending_pr_url, 'open'
FROM orchestration.agents a
WHERE a.pending_pr_number IS NOT NULL
  AND a.pending_pr_url IS NOT NULL
ON CONFLICT (pr_number) DO NOTHING;

UPDATE orchestration.agents
SET lifecycle = 'active', updated_at = now()
WHERE lifecycle = 'proposed';

-- ── Real table names, for the new-table collision check ──────────────────────
-- SECURITY DEFINER so the runtime (service_role) gets the authoritative list without needing
-- information_schema exposed through PostgREST. Read-only; returns names only.

CREATE OR REPLACE FUNCTION public.list_orchestration_tables()
RETURNS TABLE (table_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'orchestration'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  ORDER BY 1;
$$;

GRANT EXECUTE ON FUNCTION public.list_orchestration_tables() TO service_role;

COMMIT;
