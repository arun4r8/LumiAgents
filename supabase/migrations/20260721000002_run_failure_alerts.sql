-- run_failure_alerts: one row per orchestration, tracking the current failure streak
-- and when we last emailed about it.
--
-- Why this exists: in July 2026 the Anthropic API ran out of credits and
-- beady/opportunity-sweep, beady/industry-day-sweep and cleo/award-sweep failed every
-- run for days without anyone being told. The only health check we had lived *inside*
-- beady/opportunity-sweep, ran before the LLM scoring step, and only looked at source
-- (SAM/SBIR) failures, so a run that died later was completely silent.
--
-- The runtime now alerts whenever a run transitions to 'failed', for every
-- orchestration. This table is the suppression ledger that keeps a daily cron failing
-- for a week from sending a week of identical emails: the runtime alerts on the first
-- failure of a streak, when the error fingerprint changes, or once per cooldown
-- window, and reads/writes that decision here.
--
-- Rollback: DROP TABLE orchestration.run_failure_alerts;

CREATE TABLE IF NOT EXISTS orchestration.run_failure_alerts (
  orchestration_name   text        PRIMARY KEY,
  -- Normalised error signature (ids, uuids and timestamps stripped) so that the same
  -- underlying breakage across runs collapses to one value.
  error_fingerprint    text        NOT NULL,
  last_error           text,
  consecutive_failures integer     NOT NULL DEFAULT 1,
  -- Run id of the most recent failure, so a Workflow replay of the *same* run cannot
  -- inflate the streak or re-trigger an alert.
  last_failed_run_id   uuid,
  first_failed_at      timestamptz NOT NULL DEFAULT now(),
  last_failed_at       timestamptz NOT NULL DEFAULT now(),
  -- NULL means the streak has never been emailed about (every alert path sets it).
  last_alerted_at      timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orchestration.run_failure_alerts ENABLE ROW LEVEL SECURITY;
-- Internal plumbing: only the runtime (service_role, which bypasses RLS) touches it.
-- No policies are defined, so any other role sees an empty table.
GRANT ALL ON orchestration.run_failure_alerts TO service_role;
