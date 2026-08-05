-- Re-run lineage for orchestration.runs.
--
-- `POST /api/runs/:id/rerun` re-dispatches an orchestration with the input a
-- previous run stored, as a BRAND NEW run (the original is never mutated). This
-- column records which run that input came from.
--
-- Why a new column instead of reusing `triggered_by_run_id`
-- ─────────────────────────────────────────────────────────
-- `triggered_by_run_id` is the *invocation* lineage. It pairs with
-- trigger_source 'orchestration' and means "a parent orchestration invoked this
-- run" — docs/data-model.md calls it "for child runs". A re-run is not a child
-- of the run it copies: it is an independent, human-triggered successor. It
-- keeps `triggered_by = 'user'` and `triggered_by_user_id` = whoever pressed
-- Re-run (which is also what the enduser RLS policy on this table reads, so
-- attribution has to stay truthful). Overloading `triggered_by_run_id` would
-- make every present and future reader of the parent/child graph render a
-- re-run as a descendant of an unrelated run, and would leave "who triggered
-- this?" ambiguous between a person and a parent orchestration.
--
-- Nullable, and ON DELETE SET NULL: deleting the original must never cascade
-- into the re-run, which is a real run with real output of its own. The partial
-- index keeps the (rare) "show me the re-runs of this run" lookup cheap without
-- indexing the overwhelmingly NULL majority.
--
-- No RLS change is needed: orchestration.runs already has ops_all +
-- enduser_read_own_or_approval, neither of which references this column, and a
-- new column on an RLS-protected table inherits those policies.
--
-- Rollback:
--   DROP INDEX IF EXISTS orchestration.runs_rerun_of_idx;
--   ALTER TABLE orchestration.runs DROP COLUMN IF EXISTS rerun_of;

ALTER TABLE orchestration.runs
  ADD COLUMN IF NOT EXISTS rerun_of uuid
  REFERENCES orchestration.runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS runs_rerun_of_idx
  ON orchestration.runs(rerun_of)
  WHERE rerun_of IS NOT NULL;

COMMENT ON COLUMN orchestration.runs.rerun_of IS
  'The run this run was re-dispatched from (POST /api/runs/:id/rerun). Successor lineage — for parent/child invocation see triggered_by_run_id.';
