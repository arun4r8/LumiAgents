-- Seed the orchestration registry with all active Workers orchestrations.
-- Idempotent via ON CONFLICT; safe to re-run at any time.
-- n8n-only flows (govcon-assessment, resume-*) are intentionally absent.

INSERT INTO orchestration.orchestrations
  (name, version, description, input_schema, output_schema, is_active)
VALUES
  ('angie/candidate-sourcing', 1,
    'Source candidates for a role via Apollo.io: extracts search params, filters by fit, surfaces a shortlist, and drafts outreach on approval',
    '{}', '{}', false),  -- requires APOLLO_API_KEY; enable once secret is provisioned

  ('beady/opportunity-search', 1,
    'Search SAM.gov for open solicitations, score each against Lumiture''s capabilities, and return a prioritised shortlist',
    '{}', '{}', true),

  ('money/data-analyst', 1,
    'Answer business questions by generating and running SQL against Lumiture''s data, then interpreting the results',
    '{}', '{}', true),

  ('money/financial-report', 1,
    'Query Lumiture''s financial data (contracts, budget lines, invoices, labor) and produce an executive financial report',
    '{}', '{}', true),

  ('patch/inbound-triage', 1,
    'Triage inbound email or Teams messages: classify, extract action items, route or auto-respond',
    '{}', '{}', true),

  ('patch/ticket-ops', 1,
    'Create, update, or search Jira tickets for ops. Patch''s primary ticketing interface',
    '{}', '{}', true),

  ('patch/staff-request', 1,
    'Log a staff or operational request, create a Jira ticket in the HR project, and notify the team',
    '{}', '{}', true),

  ('patch/document-ingest', 1,
    'Ingest a document into the RAG knowledge base: chunks, embeds, and stores it',
    '{}', '{}', true),

  ('patch/document-query', 1,
    'Answer a question using the company document knowledge base (RAG)',
    '{}', '{}', true),

  ('patch/vault-sync', 1,
    'Sync Obsidian vault from GitHub, ingesting changed markdown files into the RAG knowledge base',
    '{}', '{}', true)

ON CONFLICT (name, version) DO UPDATE SET
  description = EXCLUDED.description,
  is_active   = EXCLUDED.is_active,
  updated_at  = now();
