-- scored_notices: a dedup ledger of every opportunity the sweep has ever scored,
-- pass or pursue. Previously the sweep deduped against public.opportunities, which
-- only holds the *saved* shortlist (fit >= minScore) — so notices scored below the
-- threshold weren't remembered and could be re-scored (re-billed to the LLM) on a
-- later run. beady/opportunity-sweep now records every scored notice here and dedups
-- against this table, so nothing is ever scored twice.
--
-- notice_id matches opportunities.sam_notice_id: the raw SAM.gov noticeId for SAM
-- rows, and `sbir_<topicNumber>` for SBIR/STTR topics.
--
-- Rollback: DROP TABLE orchestration.scored_notices;

CREATE TABLE IF NOT EXISTS orchestration.scored_notices (
  notice_id      text        PRIMARY KEY,
  source         text,
  fit_score      integer,
  recommendation text,
  scored_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orchestration.scored_notices ENABLE ROW LEVEL SECURITY;
-- Internal plumbing: only the runtime (service_role, which bypasses RLS) touches it.
GRANT ALL ON orchestration.scored_notices TO service_role;

-- Backfill from already-saved opportunities so the first post-deploy sweep treats
-- everything currently persisted as already-scored (no re-scoring on cutover).
INSERT INTO orchestration.scored_notices (notice_id, source, fit_score, recommendation, scored_at)
SELECT sam_notice_id, source, fit_score, recommendation, COALESCE(last_scored_at, now())
FROM public.opportunities
WHERE sam_notice_id IS NOT NULL
ON CONFLICT (notice_id) DO NOTHING;
