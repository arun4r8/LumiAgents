-- Migration 0002: Migrate custom users table to Supabase Auth
-- Context: public.users has username/password columns — passwords in Postgres is a security risk.
-- We keep the table as a profile extension linked to auth.uid(), remove password storage.
-- Rollback: restore password column, remove auth_id column (manual — requires restoring credentials elsewhere)

-- Step 1: Add auth_id column to link to Supabase Auth
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL;

-- Step 2: Drop password column (passwords should never live in app tables)
-- Run this only AFTER all users have been migrated to Supabase Auth logins.
-- Uncomment when ready:
-- ALTER TABLE public.users DROP COLUMN IF EXISTS password;
-- ALTER TABLE public.users DROP COLUMN IF EXISTS username;

-- Step 3: Enable RLS on users table (currently unprotected)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Ops can read all profiles
CREATE POLICY "ops_read_all" ON public.users
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'role') = 'ops');

-- Users can read and update their own profile
CREATE POLICY "user_read_own" ON public.users
  FOR SELECT TO authenticated
  USING (auth_id = auth.uid());

CREATE POLICY "user_update_own" ON public.users
  FOR UPDATE TO authenticated
  USING (auth_id = auth.uid())
  WITH CHECK (auth_id = auth.uid());

-- Service role full access
GRANT ALL ON public.users TO service_role;
GRANT SELECT, UPDATE ON public.users TO authenticated;

-- Step 4: Helper view so runtime can look up user by auth_id easily
CREATE OR REPLACE VIEW orchestration.user_profiles AS
  SELECT
    u.user_id,
    u.auth_id,
    u.firstname,
    u.lastname,
    u.email,
    u.role,
    u.is_active
  FROM public.users u
  WHERE u.auth_id IS NOT NULL;

GRANT SELECT ON orchestration.user_profiles TO service_role, authenticated;
