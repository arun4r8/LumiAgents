-- ============================================================================
-- An operational alert list, separate from the business digests  (#233)
--
-- Every operational email -- a failed run, a broken sweep, the watchdog -- resolved
-- its recipients through orchestration.subscriptions with no kind filter, which
-- returned the DIGEST list. That list is one person, a business user. So on
-- 2026-09-14 the Anthropic credit outage paged him, and nobody with the access to
-- fix it.
--
-- A digest is a business report. An alert is an operational page. Different
-- audiences, same table, now told apart by kind:
--   opportunity, award  -> business digests (unchanged)
--   alert               -> who gets paged: Arun, Travis and Joe. Not Tommy, per the
--                          2026-09-14 decision; he keeps his digests.
--
-- `cadence` and `min_fit_score` are NOT NULL on this table and mean nothing for
-- alerts, which are sent when something breaks, not on a schedule. They are set to
-- the neutral values below only to satisfy the columns; nothing reads them for
-- kind='alert'. The digest senders filter kind=eq.opportunity / eq.award
-- (runtime/src/utils/subscription-digest.ts), so this row is never sent a digest.
--
-- Rollback:
--   DELETE FROM orchestration.subscriptions WHERE kind = 'alert';
--   ALTER TABLE orchestration.subscriptions DROP CONSTRAINT subscriptions_kind_check;
--   ALTER TABLE orchestration.subscriptions ADD CONSTRAINT subscriptions_kind_check
--     CHECK (kind IN ('opportunity', 'award'));
--   (and revert the code, or alerts go to nobody)
-- ============================================================================

ALTER TABLE orchestration.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_kind_check;
ALTER TABLE orchestration.subscriptions ADD CONSTRAINT subscriptions_kind_check
  CHECK (kind IN ('opportunity', 'award', 'alert'));

INSERT INTO orchestration.subscriptions (label, kind, cadence, recipients, min_fit_score, is_active)
SELECT 'Operational alerts', 'alert', 'daily',
       ARRAY['arun.rajendra@lumiture.com', 'travis.chan@lumiture.com', 'joe.trefilek@lumiture.com'],
       0, true
WHERE NOT EXISTS (SELECT 1 FROM orchestration.subscriptions WHERE kind = 'alert');
