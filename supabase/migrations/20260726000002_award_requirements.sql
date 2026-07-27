-- Add eligibility REQUIREMENT columns to awards so the sweep can persist what each
-- award demands of an applicant (extracted structurally, not judged against any one
-- company). The award digest matches these against each subscriber's eligibility
-- profile (orchestration.subscriptions) so subscribers only get awards they qualify
-- for. All nullable; no strict CHECK so future classifier values won't break inserts.
--
-- Rollback:
--   ALTER TABLE public.awards
--     DROP COLUMN IF EXISTS set_aside_required,
--     DROP COLUMN IF EXISTS owner_required,
--     DROP COLUMN IF EXISTS revenue_cap_usd,
--     DROP COLUMN IF EXISTS applicant_type,
--     DROP COLUMN IF EXISTS min_years,
--     DROP COLUMN IF EXISTS max_years;

ALTER TABLE public.awards ADD COLUMN IF NOT EXISTS set_aside_required text;
ALTER TABLE public.awards ADD COLUMN IF NOT EXISTS owner_required     text;
ALTER TABLE public.awards ADD COLUMN IF NOT EXISTS revenue_cap_usd    bigint;
ALTER TABLE public.awards ADD COLUMN IF NOT EXISTS applicant_type     text;
ALTER TABLE public.awards ADD COLUMN IF NOT EXISTS min_years          int;
ALTER TABLE public.awards ADD COLUMN IF NOT EXISTS max_years          int;
