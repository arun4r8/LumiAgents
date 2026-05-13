-- Dynamic schedule registry for the meta-cron dispatcher.
-- The Worker fires every 5 minutes; this table tells it what to run and when.

CREATE TABLE orchestration.schedules (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  orchestration_name text        NOT NULL,
  label              text,                          -- human-friendly display name
  cron_expression    text        NOT NULL,          -- 5-field standard cron (UTC)
  is_active          boolean     NOT NULL DEFAULT true,
  default_input      jsonb       NOT NULL DEFAULT '{}',
  last_run_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX schedules_active_idx ON orchestration.schedules (is_active)
  WHERE is_active = true;

ALTER TABLE orchestration.schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON orchestration.schedules
  FOR ALL TO authenticated
  USING  ((auth.jwt() ->> 'role') = 'ops')
  WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

GRANT ALL    ON orchestration.schedules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.schedules TO authenticated;

-- Seed: migrate the hardcoded beady/opportunity-search cron into the table.
INSERT INTO orchestration.schedules (orchestration_name, label, cron_expression, is_active, default_input)
VALUES (
  'beady/opportunity-search',
  'Weekly opportunity scan',
  '0 8 * * 1',   -- every Monday 08:00 UTC
  true,
  '{}'
);
