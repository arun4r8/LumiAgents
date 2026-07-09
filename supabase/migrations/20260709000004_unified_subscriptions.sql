-- Unify report_subscriptions (opportunity digests) and award_subscriptions (award
-- digests) into one `subscriptions` table with a `kind` discriminator. Both were
-- near-identical; a single table means one dashboard surface, one meta-cron pattern,
-- and a trivial slot for the next digest kind (e.g. the content calendar).
--
-- Superset shape: common columns are first-class; kind-specific filter columns coexist
-- (opportunity uses sources/agencies/set_asides; award uses award_types). IDs are
-- preserved on backfill so "send this subscription now" (by id) keeps working.
--
-- Non-destructive: the old tables are left in place as a rollback net and dropped in a
-- later migration once the unified path is proven.
--
-- Rollback:
--   DROP TABLE orchestration.subscriptions;

CREATE TABLE IF NOT EXISTS orchestration.subscriptions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid,
  label         text,
  kind          text        NOT NULL CHECK (kind IN ('opportunity', 'award')),
  cadence       text        NOT NULL DEFAULT 'weekly' CHECK (cadence IN ('daily', 'weekly')),
  recipients    text[]      NOT NULL,
  min_fit_score integer     NOT NULL DEFAULT 6,
  is_active     boolean     NOT NULL DEFAULT true,
  last_sent_at  timestamptz,
  -- opportunity-kind filters
  sources       text[],
  agencies      text[],
  set_asides    text[],
  -- award-kind filters
  award_types   text[],
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_kind_active_idx
  ON orchestration.subscriptions (kind, is_active);

ALTER TABLE orchestration.subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ops_all_subscriptions" ON orchestration.subscriptions;
CREATE POLICY "ops_all_subscriptions" ON orchestration.subscriptions
  FOR ALL TO authenticated
  USING (public.is_ops()) WITH CHECK (public.is_ops());
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.subscriptions TO authenticated;
GRANT ALL ON orchestration.subscriptions TO service_role;

-- Backfill, preserving ids. Idempotent via ON CONFLICT.
INSERT INTO orchestration.subscriptions
  (id, user_id, label, kind, cadence, recipients, min_fit_score, is_active, last_sent_at, sources, agencies, set_asides, created_at, updated_at)
SELECT id, user_id, label, 'opportunity', cadence, recipients, min_fit_score, is_active, last_sent_at, sources, agencies, set_asides, created_at, updated_at
FROM orchestration.report_subscriptions
ON CONFLICT (id) DO NOTHING;

INSERT INTO orchestration.subscriptions
  (id, user_id, label, kind, cadence, recipients, min_fit_score, is_active, last_sent_at, award_types, created_at, updated_at)
SELECT id, user_id, label, 'award', cadence, recipients, min_fit_score, is_active, last_sent_at, award_types, created_at, updated_at
FROM orchestration.award_subscriptions
ON CONFLICT (id) DO NOTHING;
