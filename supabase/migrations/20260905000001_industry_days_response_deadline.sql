-- ============================================================================
-- industry_days: separate the event date from the response deadline
--
-- WHY
--   SAM.gov has no event-date field. Its opportunities API returns `postedDate`,
--   `responseDeadLine` and `archiveDate` -- none of which is "when the industry day
--   happens". That date exists only in the notice's prose.
--
--   A previous change used `responseDeadLine` as a fallback for `event_date` to lift
--   coverage. It lifted coverage by writing a semantically different value: the first
--   row it produced was an event dated 2026-06-10 swept on 2026-09-05, three months
--   in the past. `event_date` came to mean "the event date, or a registration cutoff,
--   or an archive date", and every consumer inherited the ambiguity -- ordering,
--   `daysUntil`, and the upcoming count.
--
--   The two are genuinely different real-world dates, and both are useful to a BD
--   reader ("register by X" is its own question), so they get their own columns.
--
-- AFTER THIS
--   event_date        = when the event happens. Extracted from content. Null when the
--                       source does not state one, which is the honest answer.
--   response_deadline = the registration / response cutoff, straight from SAM.gov's
--                       structured `responseDeadLine`. Null for web-sourced rows,
--                       which have no structured date.
-- ============================================================================

ALTER TABLE public.industry_days
  ADD COLUMN IF NOT EXISTS response_deadline date;

COMMENT ON COLUMN public.industry_days.event_date IS
  'When the event happens, extracted from the notice content. NULL when the source does not state one -- do not backfill this from a deadline field.';
COMMENT ON COLUMN public.industry_days.response_deadline IS
  'Registration / response cutoff from SAM.gov responseDeadLine. NOT the event date. NULL for web-sourced rows.';

-- Repair the rows the fallback mislabelled.
--
-- Identified structurally, not by id: a row whose event_date precedes the day it was
-- swept cannot be a future event, and for a sam_gov row the only way that value got
-- there is the responseDeadLine fallback. Move it to the column it belongs in and
-- clear event_date, which is now honestly unknown.
--
-- Scoped to sam_gov and to rows swept after the fallback shipped (2026-09-04), so the
-- genuinely-past events the sweep found late -- web rows, and older sam_gov rows the
-- model dated correctly from prose -- are left alone.
UPDATE public.industry_days
   SET response_deadline = event_date,
       event_date = NULL
 WHERE source = 'sam_gov'
   AND event_date IS NOT NULL
   AND event_date < created_at::date
   AND created_at >= '2026-09-04';
