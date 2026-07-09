-- Content calendar: the eminence plan (LinkedIn posts, etc.) as data. Tommy's
-- spreadsheet columns (Release Date / Topic / Asset / Description) become rows the
-- team edits in the dashboard and Cleo drafts against. Cleo fills draft_markdown and
-- advances status; a human always approves/posts (no auto-publish).
--
-- Rollback:
--   DROP TABLE public.content_calendar;
--   DELETE FROM orchestration.orchestrations WHERE name IN ('cleo/content-draft','cleo/content-plan','cleo/content-nudge');
--   DELETE FROM orchestration.schedules WHERE orchestration_name = 'cleo/content-nudge';

CREATE TABLE IF NOT EXISTS public.content_calendar (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  release_date   date,
  topic          text        NOT NULL,
  channel        text        NOT NULL DEFAULT 'linkedin',
  asset_type     text,                                   -- graphic | carousel | video | text
  asset_ref      text,                                   -- filename / URL of the asset
  description    text,                                   -- Tommy's seed "Description-Text" / brief
  draft_markdown text,                                   -- Cleo's drafted post copy + asset brief
  status         text        NOT NULL DEFAULT 'idea'
                 CHECK (status IN ('idea', 'drafting', 'ready', 'scheduled', 'posted')),
  owner          text,
  model          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_calendar_release_idx ON public.content_calendar (release_date);
CREATE INDEX IF NOT EXISTS content_calendar_status_idx  ON public.content_calendar (status);

ALTER TABLE public.content_calendar ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ops_all_content_calendar" ON public.content_calendar;
CREATE POLICY "ops_all_content_calendar" ON public.content_calendar
  FOR ALL TO authenticated
  USING (public.is_ops()) WITH CHECK (public.is_ops());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.content_calendar TO authenticated;
GRANT ALL ON public.content_calendar TO service_role;

-- Register Cleo's content orchestrations (all agent-triggered / on-demand except the
-- nudge, which the meta-cron drives on a schedule).
INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES
  ('cleo/content-draft', 1,
    'Draft a LinkedIn eminence post (copy + asset brief) for a content-calendar row, grounded in the company profile.',
    '{}', '{}', true, 'agent'),
  ('cleo/content-plan', 1,
    'Propose a run of content-calendar ideas from a theme and insert them as idea rows for the team to approve.',
    '{}', '{}', true, 'agent'),
  ('cleo/content-nudge', 1,
    'Daily nudge: Teams alert for content-calendar posts due soon that are not yet drafted/ready.',
    '{}', '{}', true, 'scheduled')
ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;

-- Schedule the nudge (09:00 UTC daily). The meta-cron dispatches due schedules.
INSERT INTO orchestration.schedules (orchestration_name, label, cron_expression, is_active, default_input)
SELECT 'cleo/content-nudge', 'Daily content-calendar nudge', '0 9 * * *', true, '{}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM orchestration.schedules WHERE orchestration_name = 'cleo/content-nudge'
);
