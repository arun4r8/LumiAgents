-- Native resume scoring: fix the column typo, allow queue-free results, default to Haiku.
--
-- Context: angie/resume-scoring no longer hands off to the n8n "Resume Worker"
-- (deactivated). It scores each résumé inline via one Claude call and writes
-- resume_results directly, so results are no longer tied to a resume_queue row.
--
-- Rollback (deliberate, manual):
--   ALTER TABLE public.resume_results RENAME COLUMN leadership_and_initiative_score
--     TO leadership_and_inititative_score;
--   ALTER TABLE public.resume_results ALTER COLUMN queued_resume_id SET NOT NULL;
--   UPDATE orchestration.orchestrations SET model = NULL WHERE name = 'angie/resume-scoring';

-- 1. Fix the long-standing column typo (…inititative… → …initiative…).
ALTER TABLE public.resume_results
  RENAME COLUMN leadership_and_inititative_score TO leadership_and_initiative_score;

-- 2. Results are now written without a queue row. The FK to resume_queue stays
--    (a non-null value must still reference a real row) but null is allowed.
ALTER TABLE public.resume_results
  ALTER COLUMN queued_resume_id DROP NOT NULL;

-- 3. Pin this orchestration to Haiku: cheap and sufficient for the rubric.
--    Ops can override per-orchestration or per-agent from /settings.
UPDATE orchestration.orchestrations
SET model = 'claude-haiku-4-5', updated_at = now()
WHERE name = 'angie/resume-scoring';
