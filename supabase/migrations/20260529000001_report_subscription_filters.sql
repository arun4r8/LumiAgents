-- Per-report filters: let each report_subscription narrow which opportunities it
-- includes, beyond the global min_fit_score. All null/empty => no filter on that
-- dimension (current behavior preserved).
--
--   sources    — restrict to specific sources ('sam_gov', 'sbir'). NULL => all.
--   agencies   — case-insensitive substring match against opportunities.agency.
--   set_asides — case-insensitive substring match against opportunities.set_aside.
--
-- Rollback:
--   ALTER TABLE orchestration.report_subscriptions
--     DROP COLUMN sources, DROP COLUMN agencies, DROP COLUMN set_asides;

ALTER TABLE orchestration.report_subscriptions
  ADD COLUMN IF NOT EXISTS sources    text[],
  ADD COLUMN IF NOT EXISTS agencies   text[],
  ADD COLUMN IF NOT EXISTS set_asides text[];
