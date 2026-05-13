-- defineTool in index.ts creates tool_call rows inside step() callbacks, but
-- the run_step_id is only available after step() creates the run_step row.
-- Tools called outside a step context (e.g. direct agent invocations) have no
-- step ID. Making this nullable allows both cases without breaking the FK.
ALTER TABLE orchestration.tool_calls ALTER COLUMN run_step_id DROP NOT NULL;
