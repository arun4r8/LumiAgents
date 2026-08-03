-- Endusers may now trigger ANY orchestration (product decision), so they must be
-- able to SEE all active orchestrations in the dashboard to run them.
--
-- The enduser_read_active policy previously also required a per-orchestration grant
-- in orchestration.orchestration_access (EXISTS ...). That table is empty, so
-- endusers saw zero orchestrations even though the runtime lets them run any. Drop
-- the grant requirement: endusers can read all *active* orchestrations.
--
-- To re-restrict later, reinstate the orchestration_access EXISTS clause (and
-- populate that table), or add a per-orchestration ops-only flag.
--
-- Rollback:
--   ALTER POLICY "enduser_read_active" ON orchestration.orchestrations
--     USING (is_active = true AND public.is_enduser()
--       AND EXISTS (SELECT 1 FROM orchestration.orchestration_access oa
--                    WHERE oa.orchestration_id = id AND oa.user_id = auth.uid()));

ALTER POLICY "enduser_read_active" ON orchestration.orchestrations
  USING (is_active = true AND public.is_enduser());
