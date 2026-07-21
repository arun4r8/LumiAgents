-- Fix two schema bugs that prevented beady/opportunity-sweep from ever persisting
-- opportunities (every upsert of a net-new row failed, so the table stayed empty):
--
--   1. public.opportunities.id (uuid PRIMARY KEY) had no default, so the sweep's
--      upsert (which doesn't supply an id) violated the NOT NULL constraint.
--   2. opportunities_source_check rejected 'sbir', but the sweep writes
--      source='sbir' for DoD SBIR/STTR topics (so SBIR rows would fail even after
--      the id fix). 'govcon_api' is kept for backward compatibility.
--
-- pgcrypto is installed, so gen_random_uuid() is available.
--
-- Rollback:
--   ALTER TABLE public.opportunities ALTER COLUMN id DROP DEFAULT;
--   ALTER TABLE public.opportunities DROP CONSTRAINT opportunities_source_check;
--   ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_source_check
--     CHECK (source = ANY (ARRAY['manual','sam_gov','govcon_api']));

ALTER TABLE public.opportunities ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE public.opportunities DROP CONSTRAINT opportunities_source_check;
ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_source_check
  CHECK (source = ANY (ARRAY['manual', 'sam_gov', 'sbir', 'govcon_api']));
