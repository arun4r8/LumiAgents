-- Agent memory, Phase 3 (retention): register system/memory-maintenance + a daily
-- schedule so the meta-cron purges idle conversations (cascading to messages and
-- memory chunks). The purge_expired_conversations function was added in Phase 1.
--
-- Rollback:
--   DELETE FROM orchestration.schedules WHERE orchestration_name='system/memory-maintenance';
--   DELETE FROM orchestration.orchestrations WHERE name='system/memory-maintenance';

INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES ('system/memory-maintenance', 1,
  'Daily agent-memory upkeep: purge conversations idle beyond the retention window.',
  '{}', '{}', true, 'cron')
ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;

INSERT INTO orchestration.schedules (orchestration_name, cron_expression, label, default_input, is_active)
SELECT 'system/memory-maintenance', '30 12 * * *', 'Daily memory retention', '{}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM orchestration.schedules WHERE orchestration_name = 'system/memory-maintenance');
