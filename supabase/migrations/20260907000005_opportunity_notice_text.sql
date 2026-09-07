-- ============================================================================
-- opportunities.notice_text + notice_text_fetched_at  (#219)
--
-- WHY
--   SAM v2's `description` field is a LINK, not the notice body. It was read as
--   prose and handed to the scoring model for every notice, so every fit_score in
--   this table was computed from a title, a NAICS code and a set-aside. Verified on
--   the 2026-09-07 run: 133 of 133 "descriptions" the model scored were URLs.
--
--   Fetching the body costs one subrequest per notice, against a Cloudflare ceiling
--   of 50 per Worker invocation. A 161-notice sweep cannot do that inline -- it is
--   the same fan-out that killed five runs. So the text is fetched by a separate
--   orchestration with its own budget, and stored here for the re-score to read.
--
-- WHY A COLUMN AND NOT A REFETCH EACH TIME
--   The body is stable unless the solicitation is amended, and an amendment already
--   has a detector (scored_notices.content_hash). Storing it means the re-score, the
--   RFI draft and any later analysis read the same text rather than each paying for
--   it, and it makes "has this been hydrated" answerable in SQL.
--
-- notice_text_fetched_at is separate from the text being non-null on purpose: a
-- notice whose body genuinely fetched empty is not the same as one never tried, and
-- conflating them would make the hydrator retry the former for ever.
-- ============================================================================

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS notice_text            text,
  ADD COLUMN IF NOT EXISTS notice_text_fetched_at timestamptz;

-- The hydrator's work queue: rows never attempted, newest first.
CREATE INDEX IF NOT EXISTS opportunities_needs_notice_text_idx
  ON public.opportunities (posted_date DESC)
  WHERE notice_text_fetched_at IS NULL;

COMMENT ON COLUMN public.opportunities.notice_text IS
  'The notice body, fetched from SAM''s description link. NULL means not fetched, or fetched and genuinely empty -- notice_text_fetched_at distinguishes those.';
COMMENT ON COLUMN public.opportunities.notice_text_fetched_at IS
  'When hydration last ran for this row, whether or not it produced text. Set even on an empty result, so the hydrator does not retry a genuinely empty notice for ever.';
