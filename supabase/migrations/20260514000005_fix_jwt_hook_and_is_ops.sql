-- Fix: the original JWT hook set claims.role = 'ops', which PostgREST
-- uses to determine the Postgres role (SET LOCAL ROLE ops). Since 'ops'
-- is not a valid Postgres role, every authenticated request was silently
-- failing with a role-switch error.
--
-- Solution: write the app role into a custom claim (user_role) and leave
-- claims.role = 'authenticated' so PostgREST continues to work normally.
-- Update is_ops() to read the new claim, with app_metadata as a fallback.

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  app_role text;
BEGIN
  app_role := event -> 'claims' -> 'app_metadata' ->> 'role';
  IF app_role IS NOT NULL THEN
    -- Use a custom claim; do NOT override 'role', which PostgREST uses
    -- to determine the Postgres role (authenticated / anon / service_role).
    event := jsonb_set(event, '{claims,user_role}', to_jsonb(app_role));
  END IF;
  RETURN event;
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM authenticated, anon, public;

-- Update is_ops() to check the new user_role claim (plus app_metadata fallback).
CREATE OR REPLACE FUNCTION public.is_ops() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT
    (auth.jwt() ->> 'user_role') = 'ops'
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'ops'
$$;

GRANT EXECUTE ON FUNCTION public.is_ops() TO authenticated;
