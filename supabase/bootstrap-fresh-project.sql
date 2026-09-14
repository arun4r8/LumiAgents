-- ============================================================================
-- bootstrap-fresh-project.sql
--
-- WHAT THIS IS
--   A one-shot, idempotent preparation script that makes a *brand-new, empty*
--   Supabase project able to replay `supabase/migrations/` from migration 0001
--   to HEAD with `supabase db push`.
--
-- WHY IT EXISTS
--   The migration chain is NOT self-contained. It was written against a
--   database that already existed: the n8n-era schema, which was created by
--   hand in the Supabase dashboard and never captured in a migration. The very
--   first migrations therefore ALTER, ENABLE RLS ON, and add FKs to ~23 tables
--   that no migration ever CREATEs. Replaying the chain against an empty
--   project fails immediately and repeatedly.
--
--   That is a disaster-recovery gap, not just staging friction: without this
--   file the repository alone cannot reconstruct production. This script closes
--   that gap by re-creating just enough of the pre-migration schema for the
--   chain to run.
--
-- WHEN TO RUN IT
--   ONLY on a brand-new, empty Supabase project, BEFORE the first
--   `supabase db push`. Never against production. Never against a project that
--   already has migrations applied (it is safe there — everything is guarded —
--   but it is also pointless).
--
--   It is safe to re-run. Every statement is `IF NOT EXISTS` / `CREATE OR
--   REPLACE` / guarded by a `DO $$ ... $$` existence check. Re-running it
--   part-way through a `db push` is an expected workflow (see the note on the
--   `vector` extension in section 0).
--
-- THIS IS NOT A MIGRATION
--   Do NOT move, copy, or symlink this file into `supabase/migrations/`. It has
--   no timestamp prefix on purpose. It is deliberately outside the chain: it
--   describes the state the chain *assumes*, and the CLI must never record it
--   in `supabase_migrations.schema_migrations`.
--
-- HOW TO RUN IT
--   Supabase dashboard → SQL Editor → paste → Run. Or:
--     psql "$DATABASE_URL" -f supabase/bootstrap-fresh-project.sql
--
-- IS IT STILL CORRECT?
--   `scripts/verify-db-rebuild.sh` proves it -- it spins a throwaway Postgres,
--   runs this file, replays every migration in order, and compares the result
--   against supabase/expected-shape.json. CI runs it on every change under
--   supabase/ (issue #125). If you add a migration that assumes a shape this
--   file does not create, that build goes red immediately rather than during
--   the next disaster recovery.
--
-- SCOPE / FIDELITY
--   These tables are vestigial. Most are empty in production, several are
--   dropped again by later migrations in the same chain
--   (`public.users` by 20260724000003; `*_vt` by 20260724000001), and the rest
--   only ever receive `ENABLE ROW LEVEL SECURITY` + a GRANT. The goal here is
--   NOT to reproduce the n8n-era schema faithfully -- it is only to let the
--   chain replay. Columns were derived from what the migrations themselves
--   ALTER / RENAME / reference, not from a dump of production. Where a column
--   list or a data type could not be established from the migrations, the table
--   is created with an `id` primary key only, and that is called out inline.
--
--   Consequence: after `db push` completes, a fresh project will have a few
--   extra never-used columns and will be MISSING legacy columns that no
--   migration and no application code ever touches. That is intentional.
--
-- SEE ALSO
--   docs/environments.md → "Rebuilding the database from scratch"
-- ============================================================================


-- ============================================================================
-- 0. Extensions
-- ============================================================================
-- Supabase ships an `extensions` schema; create it defensively anyway.
CREATE SCHEMA IF NOT EXISTS extensions;

-- pgvector. Two migrations reference the type by BARE name (`vector(1024)` in
-- 20260506000003 and 20260624000002) and one references it SCHEMA-QUALIFIED
-- (`extensions.vector` in 20260709000002). Production has the extension in
-- `extensions`; a brand-new project installs it into `public`, so the
-- schema-qualified reference fails with:
--     ERROR: type extensions.vector does not exist
--
-- To satisfy both spellings we (a) put the extension in `extensions` and
-- (b) append `extensions` to the search_path of the roles that apply
-- migrations, so the bare references still resolve. `supabase db push` applies
-- migrations with a search_path that does not include `extensions` by default
-- -- see the comment block at the top of 20260709000002.
DO $$
DECLARE
  v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'vector';

  IF v_schema IS NULL THEN
    EXECUTE 'CREATE EXTENSION vector WITH SCHEMA extensions';
  ELSIF v_schema <> 'extensions' THEN
    EXECUTE 'ALTER EXTENSION vector SET SCHEMA extensions';
  END IF;
END $$;

-- Make `extensions` resolvable for the migration session. Additive: this is the
-- Supabase default search_path with `extensions` appended. Takes effect on the
-- NEXT session, which is what `supabase db push` opens.
--
-- If you would rather not touch role search_path at all, the alternative is
-- ordering: leave `vector` in `public`, run `db push` until it stops at
-- 20260709000002 with "type extensions.vector does not exist", then re-run this
-- script (the DO block above will move the extension) and continue. By that
-- point both bare-`vector` migrations have already applied.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'ALTER ROLE %I IN DATABASE %I SET search_path TO %s',
        r, current_database(), '"$user", public, extensions'
      );
    END IF;
  END LOOP;
END $$;


-- ============================================================================
-- 1. public.set_updated_at()
-- ============================================================================
-- A legacy trigger function from the n8n era. 20260506000005 attaches it to
-- three tables (`CREATE TRIGGER ... EXECUTE FUNCTION public.set_updated_at()`)
-- but no migration ever defines it, so a fresh project fails with:
--     ERROR: function public.set_updated_at() does not exist
--
-- Note this is the `public` twin of `orchestration.set_updated_at()`, which
-- 20260506000001 DOES define. Same body.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- ============================================================================
-- 2. public.users -- the pre-Supabase-Auth custom users table
-- ============================================================================
-- Required by:
--   20260506000002  ADD COLUMN auth_id, ENABLE RLS, CREATE POLICY, and the
--                   orchestration.user_profiles view (selects user_id,
--                   firstname, lastname, email, role, is_active)
--   20260506000004  DROP COLUMN password / username
--   20260724000003  DROP TABLE (this table does not survive the chain)
--
-- `username`/`password` are created here even though 0004 drops them, because
-- 0004's `DROP COLUMN IF EXISTS` is the migration that documents their removal;
-- creating them keeps the replay faithful. `user_id` is bigint because the
-- legacy frontend used integer user IDs (see 20260522000001); the exact legacy
-- type is NOT verifiable from the repo and nothing depends on it.
CREATE TABLE IF NOT EXISTS public.users (
  user_id    bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  firstname  text,
  lastname   text,
  email      text,
  role       text,
  is_active  boolean     NOT NULL DEFAULT true,
  username   text,
  password   text,
  created_at timestamptz NOT NULL DEFAULT now()
);


-- ============================================================================
-- 3. public.opportunities -- the one legacy table with real structural deps
-- ============================================================================
-- Required by:
--   20260506000004  ENABLE RLS + ops_all policy
--   20260506000005  ADD COLUMN solicitation_number/sam_notice_id/agency/... ,
--                   CREATE TRIGGER opportunities_updated_at
--   20260506000006  ADD COLUMN fit_score/fit_reason/red_flags/...
--   202605080911    govcon_assessments.opportunity_id REFERENCES
--                   public.opportunities(id)   <-- needs the PRIMARY KEY
--   20260512000002  sync trigger UPDATEs it by id
--   20260516000001  ADD COLUMN title/naics_code/...
--   20260530000001  ALTER COLUMN id SET DEFAULT + DROP/ADD
--                   opportunities_source_check <-- needs the CHECK to pre-exist
--   20260531000001  SELECT sam_notice_id, source, fit_score, recommendation
--   20260602000001  ADD COLUMN notice_type
--
-- Only `id` and `source` are created here. Every other column arrives via
-- `ADD COLUMN IF NOT EXISTS` in the migrations above -- creating them here would
-- make those ADDs no-op and silently drop the inline CHECK/UNIQUE constraints
-- that come with them.
--
-- `id` deliberately has NO DEFAULT: 20260530000001 is the migration that adds
-- `DEFAULT gen_random_uuid()`, and that is a bug fix worth replaying honestly.
CREATE TABLE IF NOT EXISTS public.opportunities (
  id uuid PRIMARY KEY
);

-- `source` must exist here WITH its CHECK constraint. 20260506000005 would
-- normally create both via `ADD COLUMN IF NOT EXISTS source ... CHECK (...)`,
-- which Postgres names `opportunities_source_check`. But 20260530000001 later
-- does an UNGUARDED `DROP CONSTRAINT opportunities_source_check`, so the
-- constraint must exist by then no matter which path created the column:
--     ERROR: constraint "opportunities_source_check" of relation
--            "opportunities" does not exist
-- The value list below is the ORIGINAL three-value list; 20260530000001 is what
-- adds 'sbir'. Do not pre-add it here.
ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  ALTER TABLE public.opportunities
    ADD CONSTRAINT opportunities_source_check
    CHECK (source = ANY (ARRAY['manual', 'sam_gov', 'govcon_api']));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;


-- ============================================================================
-- 4. public.assessments -- written by the n8n GovCon Qualification flow
-- ============================================================================
-- Required by:
--   20260506000004  ENABLE RLS + ops_all policy
--   20260512000002  AFTER INSERT OR UPDATE OF weighted_score, go_no_go trigger,
--                   which reads NEW.weighted_score, NEW.go_no_go,
--                   NEW.opportunity_id
--   20260527000001  GRANT SELECT TO analyst_ro
--
-- Only the three columns the trigger touches are reproduced. The n8n-era table
-- had more (per-factor breakdowns etc.); they are unknowable from this repo and
-- nothing in the chain or the runtime reads them.
CREATE TABLE IF NOT EXISTS public.assessments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid REFERENCES public.opportunities (id) ON DELETE CASCADE,
  weighted_score numeric,
  go_no_go       text,
  created_at     timestamptz NOT NULL DEFAULT now()
);


-- ============================================================================
-- 5. Résumé pipeline tables
-- ============================================================================
-- resume_jobs -- required by:
--   20260506000004  ENABLE RLS + ops_all policy
--   20260512000003  bump_job_progress() reads/writes processed, total, status
--                   and matches on id
--   20260522000001  ALTER COLUMN user_id DROP NOT NULL  <-- must start NOT NULL
--   20260527000001  GRANT SELECT TO analyst_ro
CREATE TABLE IF NOT EXISTS public.resume_jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- bigint, not uuid: 20260522000001 describes user_id as an integer ID from the
  -- old frontend. Nothing reads it; the only reason it exists is so that
  -- migration's DROP NOT NULL is meaningful.
  user_id    bigint      NOT NULL,
  status     text        NOT NULL DEFAULT 'pending',
  processed  integer     NOT NULL DEFAULT 0,
  total      integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- resume_queue -- required by:
--   20260506000004  ENABLE RLS + ops_all policy
--   20260512000003  claim_resume_queue() RETURNS SETOF public.resume_queue and
--   20260522000004  reads/writes status, locked_at, locked_by, created_at, id
--   20260522000006
--   20260524000001  resume_results.queued_resume_id FKs to id
CREATE TABLE IF NOT EXISTS public.resume_queue (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     uuid        REFERENCES public.resume_jobs (id) ON DELETE CASCADE,
  status     text        NOT NULL DEFAULT 'queued',
  locked_at  timestamptz,
  locked_by  text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- resume_results -- required by:
--   20260506000004  ENABLE RLS + ops_all policy
--   20260524000001  RENAME COLUMN leadership_and_inititative_score
--                            TO   leadership_and_initiative_score
--                   ALTER COLUMN queued_resume_id DROP NOT NULL
--   20260527000001  GRANT SELECT TO analyst_ro
--
-- !!! THE TYPO IS LOAD-BEARING !!!
-- The column below is spelled `leadership_and_inititative_score` (three t's,
-- "inititative") ON PURPOSE. That was the original n8n-era spelling, and
-- 20260524000001 is the migration that fixes it. Seeding this table from
-- production's CURRENT schema -- which already has the corrected spelling --
-- makes that migration fail with:
--     ERROR: column "leadership_and_inititative_score" does not exist
-- Do not "fix" it here. After `db push` the column is correctly spelled.
--
-- The scoring columns' exact set and types are not recoverable from the repo;
-- only the renamed one is reproduced, as numeric.
CREATE TABLE IF NOT EXISTS public.resume_results (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queued_resume_id                  uuid NOT NULL
                                      REFERENCES public.resume_queue (id)
                                      ON DELETE CASCADE,
  leadership_and_inititative_score  numeric,
  created_at                        timestamptz NOT NULL DEFAULT now()
);


-- ============================================================================
-- 6. Tables extended by 20260506000005
-- ============================================================================
-- candidates -- 20260506000005 adds every business column (apollo_id UNIQUE,
-- source + CHECK, source_run_id FK to orchestration.runs, created_at/updated_at)
-- and CREATE TRIGGER candidates_updated_at. Create the shell only, so those
-- ADD COLUMN statements (and their inline constraints) actually run.
-- Also: 20260527000001 GRANTs SELECT on it to analyst_ro.
CREATE TABLE IF NOT EXISTS public.candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

-- staff_requests -- same shape of dependency: 20260506000005 adds title,
-- request_type, priority, status, jira_*, timestamps and the updated_at trigger;
-- 20260516000001 adds urgency/contract_id and backfills urgency from priority.
CREATE TABLE IF NOT EXISTS public.staff_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);


-- ============================================================================
-- 7. Remaining legacy tables -- RLS/GRANT targets only
-- ============================================================================
-- Every table below is referenced by exactly one or two migrations, and only to
-- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `CREATE POLICY "ops_all"`
-- (20260506000004), repoint that policy at public.is_ops() (20260506000008), and
-- in some cases `GRANT SELECT ... TO analyst_ro` (20260527000001). No migration
-- reads or writes a single column of any of them.
--
-- Each is created here with an `id` primary key and a `created_at` only. Their
-- real n8n-era columns were recovered from a production dump and are added in
-- section 8, below, once every table exists.
CREATE TABLE IF NOT EXISTS public.budget_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.capability_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.company_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.icp_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.incumbent_research (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.indirect_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.labor_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.opportunity_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.past_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.prompt_bank (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The two retired Google-Gemini (3072-dim) vector stores. They no longer exist
-- in production at all -- 20260724000001 drops them -- but 20260506000004 and
-- 20260506000008 still enable RLS on them, so the chain needs them to exist for
-- the ~2.5 months of migration history in between. Created WITHOUT an embedding
-- column: nothing in the chain touches one.
CREATE TABLE IF NOT EXISTS public.opportunity_documents_vt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.past_performance_vt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);



-- ============================================================================
-- 8. Legacy columns recovered from production  (#180)
-- ============================================================================
-- Sections 3-7 create the n8n-era tables as the MINIMUM the migration chain
-- needs, because their full shapes were "not recoverable from this repo". They
-- were recoverable from production. A rebuild without them was missing 174
-- columns across 20 tables -- including opportunities.evaluation_basis,
-- num_past_performances_required and extracted_facts, which the GovCon
-- assessment reads and writes, so a rebuilt database could not run it.
--
-- Generated from information_schema.columns in production (2026-09-14), minus
-- every column a rebuild already has. That subtraction is what makes these safe
-- to add here, BEFORE the migrations:
--   - a column present in production but absent from a rebuild is not added by
--     any migration (or the rebuild would have it), so no migration's
--     `ADD COLUMN IF NOT EXISTS ... <inline constraint>` is turned into a no-op;
--   - nor is it dropped or renamed away by one (or production would lack it).
-- They live in their own section, rather than folded into the CREATE TABLEs
-- above, so the reasoning in those sections about what each migration needs
-- stays true and readable.
--
-- Carried: type, and NOT NULL where production has a default to satisfy it.
-- Not carried, deliberately:
--   - defaults that reference objects the bootstrap does not create (sequences);
--   - NOT NULL with no default, which would break the migrations that seed rows;
--   - foreign keys and CHECK constraints, which information_schema.columns does
--     not describe. This closes the COLUMN gap; constraint parity is separate.
-- To regenerate: diff production's information_schema.columns against a
-- `scripts/verify-db-rebuild.sh --keep` container for the tables above.
--
-- NOT NULL omitted (no default to satisfy it during replay):
--   assessments.result
--   budget_lines.contract_id
--   budget_lines.budgeted
--   company_profiles.company_name
--   company_profiles.profile
--   contracts.contract_number
--   contracts.client_name
--   employees.full_name
--   indirect_rates.fiscal_year
--   indirect_rates.rate_type
--   indirect_rates.rate_pct
--   invoices.invoice_number
--   invoices.client_name
--   invoices.amount
--   invoices.invoice_date
--   labor_records.work_date
--   labor_records.hours
--   prompt_bank.dimension
--   prompt_bank.label
--   prompt_bank.prompt_template
--   resume_queue.payload
--   staff_requests.subject
-- ============================================================================

ALTER TABLE public.assessments
  ADD COLUMN IF NOT EXISTS company_profile_id uuid,
  ADD COLUMN IF NOT EXISTS dimension_scores jsonb,
  ADD COLUMN IF NOT EXISTS weights jsonb DEFAULT '{"icp_fit": 0.25, "incumbent": 0.15, "competitive": 0.10, "requirements": 0.20, "past_performance": 0.30}'::jsonb,
  ADD COLUMN IF NOT EXISTS result jsonb,
  ADD COLUMN IF NOT EXISTS executive_memo text;

ALTER TABLE public.budget_lines
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS contract_id uuid,
  ADD COLUMN IF NOT EXISTS clin text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS fiscal_year integer,
  ADD COLUMN IF NOT EXISTS budgeted numeric,
  ADD COLUMN IF NOT EXISTS obligated numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expended numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining numeric,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS role text,
  ADD COLUMN IF NOT EXISTS date_contacted timestamptz,
  ADD COLUMN IF NOT EXISTS resume_received timestamptz;

ALTER TABLE public.capability_statements
  ADD COLUMN IF NOT EXISTS company_profile_id uuid,
  ADD COLUMN IF NOT EXISTS capability_name text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS metadata jsonb;

ALTER TABLE public.company_profiles
  ADD COLUMN IF NOT EXISTS company_name text,
  ADD COLUMN IF NOT EXISTS profile jsonb;

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS contract_number text,
  ADD COLUMN IF NOT EXISTS task_order_number text,
  ADD COLUMN IF NOT EXISTS vehicle text,
  ADD COLUMN IF NOT EXISTS solicitation_number text,
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS client_agency text,
  ADD COLUMN IF NOT EXISTS co_name text,
  ADD COLUMN IF NOT EXISTS cor_name text,
  ADD COLUMN IF NOT EXISTS contract_type text,
  ADD COLUMN IF NOT EXISTS set_aside text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS total_value numeric,
  ADD COLUMN IF NOT EXISTS obligated_value numeric,
  ADD COLUMN IF NOT EXISTS option_years integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pop_start date,
  ADD COLUMN IF NOT EXISTS pop_end date,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'active'::text NOT NULL,
  ADD COLUMN IF NOT EXISTS clins jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS opportunity_id uuid,
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS personal_email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS department text,
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS end_date date,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'active'::text NOT NULL,
  ADD COLUMN IF NOT EXISTS employment_type text,
  ADD COLUMN IF NOT EXISTS clearance_level text,
  ADD COLUMN IF NOT EXISTS manager_id uuid,
  ADD COLUMN IF NOT EXISTS jira_account_id text,
  ADD COLUMN IF NOT EXISTS github_username text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

ALTER TABLE public.icp_profiles
  ADD COLUMN IF NOT EXISTS company_profile_id uuid,
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS target_agencies text[],
  ADD COLUMN IF NOT EXISTS target_domains text[],
  ADD COLUMN IF NOT EXISTS target_set_asides text[],
  ADD COLUMN IF NOT EXISTS min_contract_value text,
  ADD COLUMN IF NOT EXISTS max_contract_value text,
  ADD COLUMN IF NOT EXISTS preferred_vehicles text[],
  ADD COLUMN IF NOT EXISTS ideal_fte_range text,
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE public.incumbent_research
  ADD COLUMN IF NOT EXISTS opportunity_id uuid,
  ADD COLUMN IF NOT EXISTS incumbent_name text,
  ADD COLUMN IF NOT EXISTS years_on_contract integer,
  ADD COLUMN IF NOT EXISTS source_urls text[],
  ADD COLUMN IF NOT EXISTS confidence text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS raw_search_results jsonb;

ALTER TABLE public.indirect_rates
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS fiscal_year integer,
  ADD COLUMN IF NOT EXISTS rate_type text,
  ADD COLUMN IF NOT EXISTS rate_basis text,
  ADD COLUMN IF NOT EXISTS rate_pct numeric,
  ADD COLUMN IF NOT EXISTS base_description text,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_date date,
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to date,
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS contract_id uuid,
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS client_agency text,
  ADD COLUMN IF NOT EXISTS amount numeric,
  ADD COLUMN IF NOT EXISTS amount_paid numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency text DEFAULT 'USD'::text,
  ADD COLUMN IF NOT EXISTS invoice_date date,
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS paid_date date,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft'::text NOT NULL,
  ADD COLUMN IF NOT EXISTS payment_terms text DEFAULT 'NET30'::text,
  ADD COLUMN IF NOT EXISTS billing_period text,
  ADD COLUMN IF NOT EXISTS line_items jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

ALTER TABLE public.labor_records
  ADD COLUMN IF NOT EXISTS employee_id uuid,
  ADD COLUMN IF NOT EXISTS employee_name text,
  ADD COLUMN IF NOT EXISTS contract_id uuid,
  ADD COLUMN IF NOT EXISTS contract_number text,
  ADD COLUMN IF NOT EXISTS clin text,
  ADD COLUMN IF NOT EXISTS work_date date,
  ADD COLUMN IF NOT EXISTS hours numeric,
  ADD COLUMN IF NOT EXISTS labor_category text,
  ADD COLUMN IF NOT EXISTS hourly_rate numeric,
  ADD COLUMN IF NOT EXISTS charge_type text DEFAULT 'direct'::text,
  ADD COLUMN IF NOT EXISTS cost_element text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS opportunity_name text,
  ADD COLUMN IF NOT EXISTS vehicle text,
  ADD COLUMN IF NOT EXISTS contract_type text,
  ADD COLUMN IF NOT EXISTS pop text,
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS estimated_fte_range text,
  ADD COLUMN IF NOT EXISTS key_requirements jsonb,
  ADD COLUMN IF NOT EXISTS evaluation_basis text,
  ADD COLUMN IF NOT EXISTS extracted_facts jsonb,
  ADD COLUMN IF NOT EXISTS page_count integer,
  ADD COLUMN IF NOT EXISTS num_past_performances_required integer,
  ADD COLUMN IF NOT EXISTS num_key_personnel_required integer,
  ADD COLUMN IF NOT EXISTS pages_per_day_ratio double precision;

ALTER TABLE public.opportunity_documents
  ADD COLUMN IF NOT EXISTS opportunity_id uuid,
  ADD COLUMN IF NOT EXISTS doc_type text,
  ADD COLUMN IF NOT EXISTS source_name text,
  ADD COLUMN IF NOT EXISTS raw_text text,
  ADD COLUMN IF NOT EXISTS metadata jsonb;

ALTER TABLE public.past_performance
  ADD COLUMN IF NOT EXISTS company_profile_id uuid,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS customer text,
  ADD COLUMN IF NOT EXISTS domain text,
  ADD COLUMN IF NOT EXISTS scope_summary text,
  ADD COLUMN IF NOT EXISTS contract_value text,
  ADD COLUMN IF NOT EXISTS period_of_performance text,
  ADD COLUMN IF NOT EXISTS relevance_tags jsonb,
  ADD COLUMN IF NOT EXISTS metadata jsonb;

ALTER TABLE public.prompt_bank
  ADD COLUMN IF NOT EXISTS dimension text,
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS prompt_template text,
  ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS version integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE public.resume_jobs
  ADD COLUMN IF NOT EXISTS job text DEFAULT 'lumiture'::text NOT NULL;

ALTER TABLE public.resume_queue
  ADD COLUMN IF NOT EXISTS user_id integer,
  ADD COLUMN IF NOT EXISTS payload jsonb,
  ADD COLUMN IF NOT EXISTS error text;

ALTER TABLE public.staff_requests
  ADD COLUMN IF NOT EXISTS employee_id uuid,
  ADD COLUMN IF NOT EXISTS employee_name text,
  ADD COLUMN IF NOT EXISTS department text,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS requested_for date,
  ADD COLUMN IF NOT EXISTS assigned_to text,
  ADD COLUMN IF NOT EXISTS jira_issue_key text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_notes text,
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- ============================================================================
-- Done. Next: `supabase link --project-ref <ref>` then `supabase db push --yes`
-- (expect to run `db push` several times -- the CLI applies migrations in
-- batches). Then the two settings that do NOT travel with `db push`: the
-- exposed schemas and the Auth access-token hook. See docs/environments.md.
-- ============================================================================
