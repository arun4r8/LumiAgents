-- ============================================================================
-- Register beady/project-folder  (#207)
--
-- Manual/agent-triggered, not scheduled: it runs when an opportunity is marked
-- Pursue, which is a human decision rather than a clock event.
--
-- Rollback:
--   DELETE FROM orchestration.orchestrations WHERE name='beady/project-folder';
-- ============================================================================

INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES ('beady/project-folder', 1,
  'Create (or find) the per-project SharePoint folder tree for a pursued opportunity, and record its driveItem id on the row.',
  '{}', '{}', true, 'manual')
ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;
