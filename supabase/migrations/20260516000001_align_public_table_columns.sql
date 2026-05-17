-- Align public table columns to match what orchestrations actually write.
-- All ADD COLUMN IF NOT EXISTS so this is safe to run against either the
-- n8n-era schema (which may have different column names) or a fresh schema.

-- opportunities: orchestrations write title / naics_code / response_deadline
ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS title             text,
  ADD COLUMN IF NOT EXISTS naics_code        text,
  ADD COLUMN IF NOT EXISTS response_deadline date,
  ADD COLUMN IF NOT EXISTS posted_date       date,
  ADD COLUMN IF NOT EXISTS source            text,
  ADD COLUMN IF NOT EXISTS source_url        text,
  ADD COLUMN IF NOT EXISTS fit_score         float,
  ADD COLUMN IF NOT EXISTS fit_reason        text,
  ADD COLUMN IF NOT EXISTS red_flags         text,
  ADD COLUMN IF NOT EXISTS recommendation    text,
  ADD COLUMN IF NOT EXISTS last_scored_at    timestamptz;

-- staff_requests: patch/staff-request writes urgency (as input) and contract_id
ALTER TABLE public.staff_requests
  ADD COLUMN IF NOT EXISTS urgency     text,
  ADD COLUMN IF NOT EXISTS contract_id uuid;

-- Backfill urgency from priority for existing rows so the dashboard shows something
UPDATE public.staff_requests
SET urgency = CASE priority
  WHEN 'Highest' THEN 'immediate'
  WHEN 'High'    THEN 'this_week'
  WHEN 'Medium'  THEN 'this_month'
  WHEN 'Low'     THEN 'no_rush'
  ELSE priority
END
WHERE urgency IS NULL AND priority IS NOT NULL;

-- Also store urgency going forward (patch/staff-request already writes priority;
-- a future version of the orchestration should write urgency too, but the column
-- must exist first).
