-- Seed orchestration rows that the runtime registry exposes but the table is missing.
--
-- Background: migration 20260517000001 DELETED money/data-analyst,
-- money/financial-report, patch/document-query, and patch/inbound-triage from
-- this table, intending them to "remain callable by agents." That intent was
-- not actually met: POST /api/orchestrations/:name/run resolves the row via
-- getOrchestrationByName() BEFORE dispatching, so a missing row makes every
-- agent tool that maps to these orchestrations fail at dispatch. Two newer
-- Beady orchestrations (sbir-topic-search, opportunity-sweep) were never seeded.
--
-- Fix: (re)insert all six with trigger_mode='agent', the established mode for
-- "exists in the registry, callable by agents, no dashboard Run button"
-- (same as angie/resume-formatting, angie/resume-scoring, beady/past-performance-seed).
-- This restores agent-callability without re-adding a manual dashboard trigger.
--
-- Idempotent via ON CONFLICT; safe to re-run.
--
-- Rollback (deliberate, manual):
--   DELETE FROM orchestration.orchestrations WHERE name IN (
--     'money/data-analyst','money/financial-report','patch/document-query',
--     'patch/inbound-triage','beady/sbir-topic-search','beady/opportunity-sweep'
--   ) AND version = 1;

INSERT INTO orchestration.orchestrations
  (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES
  ('money/data-analyst', 1,
    'Answer business questions by generating and running SQL against Lumiture''s data, then interpreting the results',
    '{}', '{}', true, 'agent'),

  ('money/financial-report', 1,
    'Query Lumiture''s financial data (contracts, budget lines, invoices, labor) and produce an executive financial report',
    '{}', '{}', true, 'agent'),

  ('patch/document-query', 1,
    'Answer a question using the company document knowledge base (RAG)',
    '{}', '{}', true, 'agent'),

  ('patch/inbound-triage', 1,
    'Triage inbound email or Teams messages: classify, extract action items, route or auto-respond',
    '{}', '{}', true, 'agent'),

  ('beady/sbir-topic-search', 1,
    'Search DoD SBIR/STTR topics (dodsbirsttr.mil), score each against Lumiture''s fit, and return a shortlist',
    '{}', '{}', true, 'agent'),

  ('beady/opportunity-sweep', 1,
    'Parallel sweep of SAM.gov and DoD SBIR/STTR in one pass: unified scoring and a saved shortlist',
    '{}', '{}', true, 'agent')

ON CONFLICT (name, version) DO UPDATE SET
  description  = EXCLUDED.description,
  is_active    = EXCLUDED.is_active,
  trigger_mode = EXCLUDED.trigger_mode,
  updated_at   = now();
