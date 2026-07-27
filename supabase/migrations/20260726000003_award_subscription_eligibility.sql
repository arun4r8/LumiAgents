-- Add an eligibility PROFILE to subscriptions so an award-kind subscription can store
-- the subscriber's own eligibility facts (set-asides held, ownership, revenue, company
-- age, headcount). The award digest matches these against each award's extracted
-- eligibility REQUIREMENTS (public.awards) so subscribers only receive awards they
-- qualify for — this moves eligibility out of the scoring prompt and into config.
--
-- All nullable and only consulted for award-kind subs (opportunity subs ignore them).
-- A null/empty profile value means "don't filter on this dimension".
--
-- Rollback:
--   ALTER TABLE orchestration.subscriptions
--     DROP COLUMN IF EXISTS held_set_asides,
--     DROP COLUMN IF EXISTS ownership,
--     DROP COLUMN IF EXISTS annual_revenue_usd,
--     DROP COLUMN IF EXISTS founded_year,
--     DROP COLUMN IF EXISTS headcount;

ALTER TABLE orchestration.subscriptions ADD COLUMN IF NOT EXISTS held_set_asides    text[];
ALTER TABLE orchestration.subscriptions ADD COLUMN IF NOT EXISTS ownership          text[];
ALTER TABLE orchestration.subscriptions ADD COLUMN IF NOT EXISTS annual_revenue_usd bigint;
ALTER TABLE orchestration.subscriptions ADD COLUMN IF NOT EXISTS founded_year       int;
ALTER TABLE orchestration.subscriptions ADD COLUMN IF NOT EXISTS headcount          int;
