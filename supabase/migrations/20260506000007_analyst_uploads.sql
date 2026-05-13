-- Migration 0007: Temporary CSV uploads for Data Analyst ad-hoc queries
-- Rollback: DROP TABLE IF EXISTS public.analyst_uploads;

-- Rows expire after 24h; enforced by expires_at + application-layer checks.
-- The data column stores parsed CSV rows as a JSON array (max 5 000 rows
-- enforced by the app layer, not a DB constraint, to keep migrations light).
COMMENT ON SCHEMA public IS 'Standard Supabase public schema';

CREATE TABLE public.analyst_uploads (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_key  text        NOT NULL,
  source_name  text        NOT NULL,
  row_count    integer,
  col_names    text[],
  data         jsonb       NOT NULL DEFAULT '[]',
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.analyst_uploads IS
  'Temporary CSV uploads for Data Analyst ad-hoc queries. Rows expire after 24h.';

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX analyst_uploads_uploaded_by_expires_at_idx
  ON public.analyst_uploads (uploaded_by, expires_at);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.analyst_uploads ENABLE ROW LEVEL SECURITY;

-- Ops role: full access
CREATE POLICY "ops_all" ON public.analyst_uploads
  FOR ALL TO authenticated
  USING  ((auth.jwt() ->> 'role') = 'ops')
  WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

-- End users: can only see and manage their own rows
CREATE POLICY "owner_select" ON public.analyst_uploads
  FOR SELECT TO authenticated
  USING (uploaded_by = auth.uid());

CREATE POLICY "owner_insert" ON public.analyst_uploads
  FOR INSERT TO authenticated
  WITH CHECK (uploaded_by = auth.uid());

CREATE POLICY "owner_delete" ON public.analyst_uploads
  FOR DELETE TO authenticated
  USING (uploaded_by = auth.uid());

-- ── Grants ────────────────────────────────────────────────────────────────────

-- Service role (runtime) gets full access — bypasses RLS by design
GRANT ALL ON public.analyst_uploads TO service_role;

-- Authenticated users get the three operations they need; UPDATE is excluded
-- because rows are immutable after insert (re-upload creates a new row)
GRANT SELECT, INSERT, DELETE ON public.analyst_uploads TO authenticated;
