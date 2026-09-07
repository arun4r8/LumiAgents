-- ============================================================================
-- Register system/run-watchdog + an hourly schedule  (#213)
--
-- The gap it fills: nothing was watching for a run that fails WITHOUT failing.
--
-- run_failure_alerts fires on status='failed', and each sweep has its own health
-- alert. Between them they covered none of what happened on 2026-09-07:
--
--   * A run killed by Cloudflare (subrequest ceiling, 524) never writes its own
--     failure -- the invocation that would write it is the one that died. It stays
--     'running' for ever. Two did, and both were found by hand with
--     `wrangler workflows instances describe`.
--   * A run that completes reporting samFound: 0 is green.
--   * A schedule that stops firing is invisible: last_run_at is written but never
--     read back in anger.
--
-- Five sweeps failed across ~35 hours while the daily digest went out describing an
-- unchanged table. Every check in this orchestration is one that would have caught
-- that on the first occurrence.
--
-- Hourly at :20, off the hour so it does not contend with the :00 crons it watches.
--
-- Rollback:
--   DELETE FROM orchestration.schedules WHERE orchestration_name='system/run-watchdog';
--   DELETE FROM orchestration.orchestrations WHERE name='system/run-watchdog';
-- ============================================================================

INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES ('system/run-watchdog', 1,
  'Hourly check for runs that failed without failing: stuck ''running'' rows the platform killed, schedules that stopped firing, and completed runs whose numbers collapsed.',
  '{}', '{}', true, 'cron')
ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;

INSERT INTO orchestration.schedules (orchestration_name, cron_expression, label, default_input, is_active)
SELECT 'system/run-watchdog', '20 * * * *', 'Hourly silent-failure watchdog', '{}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM orchestration.schedules WHERE orchestration_name = 'system/run-watchdog');
