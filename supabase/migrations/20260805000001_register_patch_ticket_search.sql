-- Register patch/ticket-search (#127).
--
-- Why this orchestration exists: `readOnly` is a property of an orchestration, not of
-- one branch of its input. patch/ticket-ops is a discriminated union whose `create` and
-- `update` branches write to Jira and post Teams cards, so it can never be flagged
-- readOnly and may never run on the retrying inline (/run-sync) path. Patch's
-- `search_tickets` tool is a pure JQL read that wants sync dispatch, so the search
-- branch gets its own read-only orchestration and the agent points that tool here.
--
-- patch/ticket-ops keeps its three-operation union unchanged; nothing else moves.
--
-- Rollback:
--   DELETE FROM orchestration.orchestrations WHERE name = 'patch/ticket-search';

INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES
  ('patch/ticket-search', 1,
    'Search Jira tickets with JQL. Read-only companion to patch/ticket-ops.',
    '{}', '{}', true, 'agent')
ON CONFLICT (name, version) DO UPDATE
  SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;
