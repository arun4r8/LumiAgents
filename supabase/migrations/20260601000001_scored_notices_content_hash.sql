-- Amendment-aware re-scoring: store a content fingerprint per scored notice so the
-- sweep can detect when a solicitation has *materially changed* (amended scope,
-- description, NAICS, set-aside, deadline) and re-score it — letting a "monitor"
-- legitimately graduate to "pursue" when the government actually changes the notice.
--
-- We fingerprint the scoring-relevant fields rather than trust a modified-date the
-- SAM.gov API doesn't reliably expose. Re-score iff the hash differs from last time.
--
-- Existing rows have a null hash; the next sweep will re-score them once to establish
-- a baseline (negligible — a handful of items), then they're stable.
--
-- Rollback: ALTER TABLE orchestration.scored_notices DROP COLUMN content_hash;

ALTER TABLE orchestration.scored_notices
  ADD COLUMN IF NOT EXISTS content_hash text;
