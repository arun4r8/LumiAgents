-- Drop dead legacy auth remnants (audit follow-up, #89).
--
-- public.users is the pre-Supabase-Auth custom users table: 0 rows since the auth
-- migration (username/password columns dropped in 20260506000004), superseded by
-- auth.users + JWT-claim roles (is_ops/is_enduser). No app code references it, and
-- nothing depends on it except the unused helper view below.
--
-- orchestration.user_profiles is a VIEW over public.users ("helper so runtime can look
-- up users") that the runtime never actually uses. Drop it first (it depends on the table).
--
-- This also removes public.users' stale ops_read_all policy (a raw role='ops' check that
-- 20260506000008 skipped because its name was not "ops_all").

DROP VIEW  IF EXISTS orchestration.user_profiles;
DROP TABLE IF EXISTS public.users CASCADE;
