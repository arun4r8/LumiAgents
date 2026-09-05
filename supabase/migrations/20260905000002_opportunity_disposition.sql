-- ============================================================================
-- Human triage on opportunities: Pursue / Watch / Ignore  (BD syncup 2026-09-01)
--
-- WHY A NEW COLUMN AND NOT `status`
--   `status` is the solicitation's own state, and the sweep hardcodes it to 'open'
--   for every row. Overloading it with a human decision would repeat the mistake we
--   just undid on industry_days, where `event_date` came to mean "the event date, or
--   a registration deadline" and every consumer inherited the ambiguity.
--
-- WHY NOT `recommendation`
--   That is Beady's SUGGESTION (pursue / consider / skip). This is the human's
--   DECISION, and the two must be able to disagree -- a person overriding the model
--   is a signal worth keeping, not one to overwrite. Keeping them apart is also what
--   lets us ask later how often the model was right.
--
-- SEMANTICS (from the meeting: "Pursue kicks off the proposal workflow; Ignore
-- removes from list; Watch leaves it visible")
--   NULL      not yet triaged -- the default, and the queue a human works through
--   'pursue'  entering the proposal workflow; shows on the pipeline board
--   'watch'   stays visible in the list, no workflow
--   'ignore'  hidden from the default list
--
--   'ignore' is a SOFT hide. Nothing is deleted: a mis-click must be recoverable, and
--   an ignored opportunity is still evidence about what the sweep surfaces.
-- ============================================================================

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS disposition     text,
  ADD COLUMN IF NOT EXISTS disposition_at  timestamptz,
  ADD COLUMN IF NOT EXISTS disposition_by  uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'opportunities'
      AND c.conname = 'opportunities_disposition_check'
  ) THEN
    EXECUTE $c$
      ALTER TABLE public.opportunities
        ADD CONSTRAINT opportunities_disposition_check
        CHECK (disposition IS NULL OR disposition IN ('pursue', 'watch', 'ignore'))
    $c$;
  END IF;
END $$;

-- The default list reads "not ignored", and the board reads "pursue". Both are
-- selective enough to be worth an index once the table grows past a few hundred rows.
CREATE INDEX IF NOT EXISTS opportunities_disposition_idx
  ON public.opportunities (disposition);

COMMENT ON COLUMN public.opportunities.disposition IS
  'Human triage decision: pursue | watch | ignore. NULL = not yet triaged. Distinct from `recommendation`, which is Beady''s suggestion -- the two are allowed to disagree.';
COMMENT ON COLUMN public.opportunities.disposition_at IS
  'When the disposition was last set.';
COMMENT ON COLUMN public.opportunities.disposition_by IS
  'auth.users id of whoever set it. No FK: auth schema ownership makes that fragile across environments, and this is attribution, not authorization.';
