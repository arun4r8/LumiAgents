-- ============================================================================
-- Pin the score scales, and bring resume_results into the migration chain (#147)
--
-- Two problems, both invisible in production and both fatal to a rebuild.
--
-- 1. `opportunities.fit_score` is declared TWICE, and the declarations disagree.
--       20260506000006:  ADD COLUMN IF NOT EXISTS fit_score smallint CHECK (1..10)
--       20260516000001:  ADD COLUMN IF NOT EXISTS fit_score float
--    Because both are IF NOT EXISTS, whichever runs first wins and the other is
--    silently skipped. Filename order currently puts the smallint version first,
--    so production AND a fresh rebuild both get smallint+CHECK -- verified. But
--    the outcome depends entirely on ordering, and #125 contemplates squashing
--    the chain into a single baseline, which is exactly the operation that would
--    flip it. A squashed chain that picked the float would give an UNCONSTRAINED
--    FLOAT where the app assumes a constrained 1-10 integer, with no failure.
--    This asserts the intended shape so ordering stops mattering.
--
-- 2. `public.resume_results` is 19 columns short of production on a rebuild.
--    Verified by scripts/verify-db-rebuild.sh: a from-scratch database produces
--    4 columns (id, queued_resume_id, leadership_and_initiative_score, created_at)
--    where production has 23. The rest were created by hand, outside the chain.
--    Every one of them is written by orchestrations/angie/resume-scoring, so the
--    entire résumé pipeline would fail on a rebuilt database -- during a disaster
--    or a new-environment setup, which is the worst possible moment.
--
-- SCALE: 1-10, not 0-100.
--    `orchestrations/angie/resume-scoring/definition.ts:53` is the authoritative
--    writer and clamps every score:
--        const clamp = (n) => Math.min(10, Math.max(1, Math.round(Number(n))));
--    All six score columns go through it. The table is empty in production (0
--    rows), so the scale could not be inferred from data -- this is the producing
--    code, not a guess. `assessments.weighted_score` is 0-100, which is a
--    DIFFERENT pipeline (beady/govcon-assessment) and is deliberately untouched.
--
-- Forward-only and idempotent: no history is rewritten, and every statement is
-- guarded so this is safe on production (where most of it is a no-op) and on a
-- fresh database (where it does the real work).
-- ============================================================================

-- ─── 1. opportunities.fit_score: assert smallint + the 1-10 CHECK ────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'opportunities'
      AND column_name = 'fit_score' AND data_type <> 'smallint'
  ) THEN
    EXECUTE 'ALTER TABLE public.opportunities
               ALTER COLUMN fit_score TYPE smallint USING fit_score::smallint';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'opportunities'
      AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%fit_score%'
  ) THEN
    EXECUTE 'ALTER TABLE public.opportunities
               ADD CONSTRAINT opportunities_fit_score_range
               CHECK (fit_score BETWEEN 1 AND 10)';
  END IF;
END $$;

-- ─── 2. resume_results: the 19 columns that live only in production ──────────
-- Types mirror production exactly (verified against information_schema), except
-- the six score columns, which are narrowed to smallint and constrained below.
ALTER TABLE public.resume_results
  ADD COLUMN IF NOT EXISTS job_id                          uuid,
  ADD COLUMN IF NOT EXISTS user_id                         integer,
  ADD COLUMN IF NOT EXISTS status                          text NOT NULL DEFAULT 'done',
  ADD COLUMN IF NOT EXISTS name                            text,
  ADD COLUMN IF NOT EXISTS email                           text,
  ADD COLUMN IF NOT EXISTS mobile_number                   text,
  ADD COLUMN IF NOT EXISTS location                        text,
  ADD COLUMN IF NOT EXISTS school                          text,
  ADD COLUMN IF NOT EXISTS field_of_study                  text,
  ADD COLUMN IF NOT EXISTS gpa                             text,
  ADD COLUMN IF NOT EXISTS grad_year                       text,
  ADD COLUMN IF NOT EXISTS role                            text,
  ADD COLUMN IF NOT EXISTS technical_skills_score          smallint,
  ADD COLUMN IF NOT EXISTS work_experience_score           smallint,
  ADD COLUMN IF NOT EXISTS academics_score                 smallint,
  ADD COLUMN IF NOT EXISTS projects_and_research_score     smallint,
  ADD COLUMN IF NOT EXISTS leadership_and_initiative_score smallint,
  ADD COLUMN IF NOT EXISTS overall_score                   smallint,
  ADD COLUMN IF NOT EXISTS rationale                       text,
  ADD COLUMN IF NOT EXISTS error                           text;

-- job_id is NOT NULL in production. Only enforceable while the table is empty;
-- guarded so this migration never fails on a database that has rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.resume_results LIMIT 1)
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='resume_results'
         AND column_name='job_id' AND is_nullable='YES'
     ) THEN
    EXECUTE 'ALTER TABLE public.resume_results ALTER COLUMN job_id SET NOT NULL';
  END IF;
END $$;

-- ─── 3. Narrow + constrain the six score columns to the 1-10 scale ───────────
-- The bootstrap creates leadership_and_initiative_score as numeric and
-- production has all six as unconstrained integer; both become smallint here.
DO $$
DECLARE
  col text;
BEGIN
  FOREACH col IN ARRAY ARRAY[
    'technical_skills_score', 'work_experience_score', 'academics_score',
    'projects_and_research_score', 'leadership_and_initiative_score', 'overall_score'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='resume_results'
        AND column_name = col AND data_type <> 'smallint'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.resume_results ALTER COLUMN %I TYPE smallint USING %I::smallint',
        col, col);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname='public' AND t.relname='resume_results'
        AND c.contype='c' AND pg_get_constraintdef(c.oid) ILIKE '%' || col || '%'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.resume_results ADD CONSTRAINT %I CHECK (%I BETWEEN 1 AND 10)',
        'resume_results_' || col || '_range', col);
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN public.resume_results.overall_score IS
  'Angie 1-10 overall résumé score (null = not yet scored). Written by orchestrations/angie/resume-scoring, which clamps to 1-10.';
