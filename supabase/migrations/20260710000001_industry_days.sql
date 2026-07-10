-- Industry days: government agency vendor-outreach events (industry days, vendor
-- days, small-business matchmaking). Beady discovers them from SAM.gov Special
-- Notices + a Tavily web sweep (agency event pages like sba.gov/event/…), scores
-- relevance to Lumiture, and upserts here. A dedup ledger keeps the sweep idempotent.
--
-- Rollback:
--   DROP TABLE public.industry_days; DROP TABLE public.industry_day_scored;
--   DELETE FROM orchestration.orchestrations WHERE name='beady/industry-day-sweep';
--   DELETE FROM orchestration.schedules WHERE orchestration_name='beady/industry-day-sweep';

CREATE TABLE IF NOT EXISTS public.industry_days (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         text        UNIQUE NOT NULL,     -- SAM notice id, or fnv1a(source_url)
  title            text        NOT NULL,
  agency           text,
  event_date       date,                            -- when it happens (null if TBD)
  location         text,                            -- city / "Virtual" / hybrid
  format           text,                            -- in-person | virtual | hybrid
  registration_url text,
  source           text        NOT NULL CHECK (source IN ('sam_gov', 'web')),
  source_url       text,
  description      text,
  fit_score        integer     CHECK (fit_score BETWEEN 1 AND 10),
  fit_reason       text,
  recommendation   text        NOT NULL DEFAULT 'consider' CHECK (recommendation IN ('attend', 'consider', 'skip')),
  last_scored_at   timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS industry_days_event_date_idx ON public.industry_days (event_date);

ALTER TABLE public.industry_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ops_all_industry_days" ON public.industry_days;
CREATE POLICY "ops_all_industry_days" ON public.industry_days
  FOR ALL TO authenticated USING (public.is_ops()) WITH CHECK (public.is_ops());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.industry_days TO authenticated;
GRANT ALL ON public.industry_days TO service_role;

-- Dedup ledger: skip re-scoring events whose content hasn't changed.
CREATE TABLE IF NOT EXISTS public.industry_day_scored (
  event_id     text        PRIMARY KEY,
  content_hash text        NOT NULL,
  scored_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.industry_day_scored ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.industry_day_scored TO service_role;

-- Register the orchestration + a weekly schedule (Mondays 10:00 UTC).
INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES ('beady/industry-day-sweep', 1,
  'Discover government agency industry days (SAM.gov Special Notices + web), score relevance to Lumiture, and upsert into industry_days.',
  '{}', '{}', true, 'agent')
ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;

INSERT INTO orchestration.schedules (orchestration_name, label, cron_expression, is_active, default_input)
SELECT 'beady/industry-day-sweep', 'Weekly industry-day sweep', '0 10 * * 1', true, '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM orchestration.schedules WHERE orchestration_name = 'beady/industry-day-sweep');
