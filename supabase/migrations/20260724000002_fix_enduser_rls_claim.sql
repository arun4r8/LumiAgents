-- Fix dead enduser RLS policies (audit #89).
--
-- The enduser SELECT policies check (auth.jwt() ->> 'role') = 'enduser', but the app
-- role lives in the custom 'user_role' claim (JWT hook, 20260514000005). The top-level
-- 'role' claim is the PostgREST Postgres role ('authenticated'), never the app role, so
-- every enduser policy evaluates false and an enduser would be denied all reads.
-- Harmless today (no enduser accounts), latent the moment #62 provisions one.
--
-- Fix: add public.is_enduser() (mirroring public.is_ops()) and repoint each policy at it.
-- Two approvals policies also compared requested_from_role to (auth.jwt() ->> 'role');
-- corrected to the 'user_role' claim. Also repoint the orchestration.schedules ops policy
-- at public.is_ops() (it was a raw role check that never matched dashboard ops users;
-- masked only because service_role bypasses RLS).
--
-- These are non-destructive policy expression changes. ops_all elsewhere already uses
-- public.is_ops() (20260506000008). NOTE: raw ops policies on orchestration.user_profiles
-- and public.users are intentionally NOT touched here pending a separate review.

-- 1) Helper, mirroring public.is_ops()
CREATE OR REPLACE FUNCTION public.is_enduser() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT
    (auth.jwt() ->> 'user_role') = 'enduser'
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'enduser'
$$;
GRANT EXECUTE ON FUNCTION public.is_enduser() TO authenticated;

-- 2) Repoint enduser policies at the helper (USING expressions only)

ALTER POLICY "enduser_read_active" ON orchestration.orchestrations
  USING (
    is_active = true
    AND public.is_enduser()
    AND EXISTS (
      SELECT 1 FROM orchestration.orchestration_access oa
      WHERE oa.orchestration_id = id
        AND oa.user_id = auth.uid()
    )
  );

ALTER POLICY "enduser_read" ON orchestration.orch_documents
  USING (public.is_enduser());

ALTER POLICY "enduser_read" ON orchestration.document_chunks
  USING (public.is_enduser());

ALTER POLICY "enduser_read_own_or_approval" ON orchestration.runs
  USING (
    public.is_enduser()
    AND (
      triggered_by_user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM orchestration.approvals a
        WHERE a.run_id = id
          AND a.requested_from_user_id = auth.uid()
      )
    )
  );

ALTER POLICY "enduser_read_if_run_visible" ON orchestration.run_steps
  USING (
    public.is_enduser()
    AND EXISTS (
      SELECT 1 FROM orchestration.runs r
      WHERE r.id = run_id
        AND (
          r.triggered_by_user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM orchestration.approvals a
            WHERE a.run_id = r.id AND a.requested_from_user_id = auth.uid()
          )
        )
    )
  );

ALTER POLICY "enduser_read_if_run_visible" ON orchestration.tool_calls
  USING (
    public.is_enduser()
    AND EXISTS (
      SELECT 1 FROM orchestration.run_steps rs
      JOIN orchestration.runs r ON r.id = rs.run_id
      WHERE rs.id = run_step_id
        AND (
          r.triggered_by_user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM orchestration.approvals a
            WHERE a.run_id = r.id AND a.requested_from_user_id = auth.uid()
          )
        )
    )
  );

ALTER POLICY "enduser_read_if_run_visible_and_not_ops_only" ON orchestration.artifacts
  USING (
    public.is_enduser()
    AND ops_only = false
    AND EXISTS (
      SELECT 1 FROM orchestration.runs r
      WHERE r.id = run_id
        AND (
          r.triggered_by_user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM orchestration.approvals a
            WHERE a.run_id = r.id AND a.requested_from_user_id = auth.uid()
          )
        )
    )
  );

ALTER POLICY "enduser_read_own" ON orchestration.approvals
  USING (
    public.is_enduser()
    AND (
      requested_from_user_id = auth.uid()
      OR requested_from_role = (auth.jwt() ->> 'user_role')
    )
  );

ALTER POLICY "enduser_decide_own" ON orchestration.approvals
  USING (
    public.is_enduser()
    AND status = 'pending'
    AND (
      requested_from_user_id = auth.uid()
      OR requested_from_role = (auth.jwt() ->> 'user_role')
    )
  );

-- 3) orchestration.schedules ops policy: use the helper instead of a raw role check
ALTER POLICY "ops_all" ON orchestration.schedules
  USING (public.is_ops())
  WITH CHECK (public.is_ops());
