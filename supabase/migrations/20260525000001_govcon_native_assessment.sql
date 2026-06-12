-- Native GovCon assessment: pin the orchestration model to Sonnet.
--
-- Context: beady/govcon-assessment no longer calls the n8n flow. It runs natively
-- in the runtime (opportunity extractor + 9-category Qualification score +
-- D1–D4 dimension scorers + Tavily incumbent research + executive memo), embedding
-- and retrieving via Workers AI (bge-1024) over orchestration.document_chunks.
--
-- This is high-stakes go/no-go judgment, so pin it to Sonnet explicitly (beady's
-- agent default is already Sonnet, but this protects the orchestration from a
-- later change to the agent default). Override per-orchestration from /settings.
--
-- The Google-Gemini (3072-dim) vector stores opportunity_documents_vt /
-- past_performance_vt and their match_*_vt RPCs are now unused by all code and
-- left dormant (both empty); drop them in a later housekeeping migration.
--
-- Rollback: UPDATE orchestration.orchestrations SET model = NULL WHERE name = 'beady/govcon-assessment';

UPDATE orchestration.orchestrations
SET model = 'claude-sonnet-4-6', updated_at = now()
WHERE name = 'beady/govcon-assessment';
