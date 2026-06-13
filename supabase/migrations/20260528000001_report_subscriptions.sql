-- Email report subscriptions (ops-only): users configure when Beady emails them
-- the latest "pursue"-rated opportunities. Sent via the beady/opportunity-report
-- orchestration on a daily meta-cron (each subscription's cadence is honored).
--
-- Rollback: DROP TABLE orchestration.report_subscriptions;
--           DELETE FROM orchestration.schedules WHERE orchestration_name='beady/opportunity-report';
--           DELETE FROM orchestration.orchestrations WHERE name='beady/opportunity-report';

CREATE TABLE IF NOT EXISTS orchestration.report_subscriptions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid,
  label         text,
  cadence       text        NOT NULL DEFAULT 'weekly' CHECK (cadence IN ('daily', 'weekly')),
  recipients    text[]      NOT NULL,
  min_fit_score integer     NOT NULL DEFAULT 7,
  is_active     boolean     NOT NULL DEFAULT true,
  last_sent_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orchestration.report_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all_report_subscriptions" ON orchestration.report_subscriptions
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.report_subscriptions TO authenticated;
GRANT ALL ON orchestration.report_subscriptions TO service_role;

-- Register the report orchestration + its daily driver schedule.
INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES ('beady/opportunity-report', 1,
  'Email the latest pursue-rated opportunities to report subscribers (cadence honored per subscription).',
  '{}', '{}', true, 'cron')
ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;

INSERT INTO orchestration.schedules (orchestration_name, cron_expression, label, default_input, is_active)
SELECT 'beady/opportunity-report', '0 13 * * *', 'Daily report dispatch', '{}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM orchestration.schedules WHERE orchestration_name = 'beady/opportunity-report');
