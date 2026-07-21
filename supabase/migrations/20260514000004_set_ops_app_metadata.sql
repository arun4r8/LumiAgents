-- Set app_metadata.role = 'ops' for all current users.
-- This is an internal tool, so every account that exists is an ops account.
-- The custom_access_token_hook then copies this into the JWT role claim,
-- which is_ops() reads to pass RLS on the orchestration schema tables.
--
-- After this migration runs, users must sign out and back in to get a
-- fresh JWT that includes the new claim.

UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data || '{"role": "ops"}'::jsonb
WHERE raw_app_meta_data ->> 'role' IS DISTINCT FROM 'ops';
