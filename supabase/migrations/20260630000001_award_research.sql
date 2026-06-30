-- Award research: weekly Tavily sweep for industry recognition awards and
-- government small business award programs, plus per-subscription email digests.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.awards;
--   DROP TABLE IF EXISTS orchestration.award_scored;
--   DROP TABLE IF EXISTS orchestration.award_subscriptions;
--   DELETE FROM orchestration.schedules WHERE orchestration_name IN ('beady/award-sweep','beady/award-report');
--   DELETE FROM orchestration.orchestrations WHERE name IN ('beady/award-sweep','beady/award-report');

-- ─── Awards table (public schema — ops dashboard reads it via RLS) ─────────────

CREATE TABLE IF NOT EXISTS public.awards (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id             text        UNIQUE NOT NULL,
  title                text        NOT NULL,
  sponsor              text,
  category             text,
  award_type           text        NOT NULL CHECK (award_type IN ('industry', 'government')),
  application_deadline text,
  nomination_deadline  text,
  source_url           text,
  fit_score            integer     CHECK (fit_score BETWEEN 1 AND 10),
  fit_reason           text,
  prestige             text        CHECK (prestige IN ('high', 'medium', 'low')),
  effort               text        CHECK (effort IN ('low', 'medium', 'high')),
  recommendation       text        NOT NULL DEFAULT 'consider' CHECK (recommendation IN ('apply', 'consider', 'skip')),
  last_scored_at       timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.awards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all_awards" ON public.awards
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.awards TO authenticated;
GRANT ALL ON public.awards TO service_role;

-- ─── Dedup ledger (orchestration schema) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS orchestration.award_scored (
  award_id     text        PRIMARY KEY,
  content_hash text,
  scored_at    timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON orchestration.award_scored TO service_role;

-- ─── Award subscriptions ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orchestration.award_subscriptions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid,
  label        text,
  cadence      text        NOT NULL DEFAULT 'weekly' CHECK (cadence IN ('daily', 'weekly')),
  recipients   text[]      NOT NULL,
  award_types  text[],
  min_fit_score integer    NOT NULL DEFAULT 6,
  is_active    boolean     NOT NULL DEFAULT true,
  last_sent_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orchestration.award_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all_award_subscriptions" ON orchestration.award_subscriptions
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.award_subscriptions TO authenticated;
GRANT ALL ON orchestration.award_subscriptions TO service_role;

-- ─── Register orchestrations + schedules ──────────────────────────────────────

INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES
  ('beady/award-sweep', 1,
   'Weekly Tavily sweep for industry recognition awards and government small business award programs. Scores each on fit, prestige, and effort.',
   '{}', '{}', true, 'cron'),
  ('beady/award-report', 1,
   'Email award digest to subscribers. Driven by a daily meta-cron; each subscription''s cadence is honored.',
   '{}', '{}', true, 'cron')
ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;

INSERT INTO orchestration.schedules (orchestration_name, cron_expression, label, default_input, is_active)
SELECT 'beady/award-sweep', '0 9 * * 1', 'Weekly award sweep (Monday 09:00 UTC)', '{}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM orchestration.schedules WHERE orchestration_name = 'beady/award-sweep');

INSERT INTO orchestration.schedules (orchestration_name, cron_expression, label, default_input, is_active)
SELECT 'beady/award-report', '0 14 * * *', 'Daily award report dispatch (14:00 UTC)', '{}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM orchestration.schedules WHERE orchestration_name = 'beady/award-report');
