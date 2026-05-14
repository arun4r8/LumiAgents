-- Custom Access Token Hook: copies app_metadata.role into the top-level JWT claims.
--
-- After applying this migration, enable the hook in the Supabase dashboard:
--   Authentication → Hooks → Custom Access Token Hook
--   → select function: public.custom_access_token_hook
--
-- For each ops user, ensure app_metadata.role = 'ops' is set:
--   Dashboard → Authentication → Users → [user] → Edit → app_metadata: {"role":"ops"}
--   Or via API: supabase.auth.admin.updateUserById(id, { app_metadata: { role: 'ops' } })

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  role_claim text;
begin
  role_claim := event -> 'claims' -> 'app_metadata' ->> 'role';
  if role_claim is not null then
    event := jsonb_set(event, '{claims,role}', to_jsonb(role_claim));
  end if;
  return event;
end;
$$;

-- supabase_auth_admin needs schema access + execute; revoke execute from app roles.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
