-- =============================================================================
-- seed.sql — Development / test seed data for the orchestration layer
--
-- What this does:
--   Upserts the canonical set of orchestration definitions into
--   orchestration.orchestrations so that the dev environment starts in a known
--   state.  input_schema / output_schema are left as '{}' — the real schemas
--   live in the TypeScript definition files and will be synced by the runtime
--   on first boot.
--
-- How to run:
--   psql "$DATABASE_URL" -f db/seed.sql
--   -- or via supabase CLI:
--   supabase db reset          (applies migrations then this file automatically
--                               if placed at supabase/seed.sql, or run manually)
--   supabase db execute --file db/seed.sql
--
-- Safety:
--   Fully idempotent — uses INSERT ... ON CONFLICT (name, version) DO UPDATE so
--   re-running is safe at any time.  Does NOT touch auth.users; user accounts
--   are managed by Supabase Auth.
-- =============================================================================

INSERT INTO orchestration.orchestrations
  (name, version, description, input_schema, output_schema, is_active)
VALUES

  -- ── Angie (recruiting) ───────────────────────────────────────────────────
  (
    'angie/resume-formatting',
    1,
    'Format a resume to Lumiture''s standard template using Claude — ATS-optimised, role-targeted',
    '{}',
    '{}',
    true
  ),
  (
    'angie/resume-screening',
    1,
    'Score a resume against a job opening, format it to standard template, and produce a hiring recommendation',
    '{}',
    '{}',
    true
  ),
  (
    'angie/candidate-sourcing',
    1,
    'Source candidates for a role via Apollo.io — extracts search params, filters by fit, surfaces a shortlist, and drafts outreach on approval',
    '{}',
    '{}',
    false   -- requires Apollo API key; enable once secret is provisioned
  ),

  -- ── Beady (business development / GovCon) ────────────────────────────────
  (
    'beady/govcon-assessment',
    1,
    'Assess a government contracting opportunity and produce a go/no-go recommendation with executive memo',
    '{}',
    '{}',
    true
  ),
  (
    'beady/opportunity-search',
    1,
    'Search SAM.gov for open solicitations, score each against Lumiture''s capabilities, and return a prioritised shortlist',
    '{}',
    '{}',
    true
  ),

  -- ── Money (finance) ───────────────────────────────────────────────────────
  (
    'money/data-analyst',
    1,
    'Answer business questions by generating and running SQL against Lumiture''s data, then interpreting the results',
    '{}',
    '{}',
    true
  ),
  (
    'money/financial-report',
    1,
    'Query Lumiture''s financial data (contracts, budget lines, invoices, labor) and produce an executive financial report',
    '{}',
    '{}',
    false   -- not yet implemented; placeholder to reserve the name
  ),

  -- ── Patch (operations / helpdesk) ─────────────────────────────────────────
  (
    'patch/inbound-triage',
    1,
    'Triage inbound email or Teams messages — classify, extract action items, route or auto-respond',
    '{}',
    '{}',
    true
  ),
  (
    'patch/ticket-ops',
    1,
    'Create, update, or search Jira tickets for ops — Patch''s primary ticketing interface',
    '{}',
    '{}',
    true
  ),
  (
    'patch/staff-request',
    1,
    'Log a staff or operational request, create a Jira ticket in the HR project, and notify the team',
    '{}',
    '{}',
    true
  ),
  (
    'patch/document-ingest',
    1,
    'Ingest a document into the RAG knowledge base — chunks, embeds, and stores it',
    '{}',
    '{}',
    true
  ),
  (
    'patch/document-query',
    1,
    'Answer a question using the company document knowledge base (RAG)',
    '{}',
    '{}',
    true
  )

ON CONFLICT (name, version) DO UPDATE SET
  description   = EXCLUDED.description,
  is_active     = EXCLUDED.is_active,
  updated_at    = now();
