-- Migration 0001 only granted SELECT to authenticated on orchestration tables.
-- RLS ops_all policies are FOR ALL (select/insert/update/delete), but Postgres
-- requires both a table-level privilege AND the RLS policy to pass.
-- Grant the missing DML privileges so ops users can actually write through
-- the dashboard (toggle is_active, trigger runs, etc.).

GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.orchestrations       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.orchestration_access TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.runs                 TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.run_steps            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.tool_calls           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.artifacts            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.approvals            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.schedules            TO authenticated;
