# Auth Model

Who logs into the dashboard, what they can see, and what they can trigger. Drives RLS policy design. Last updated: 2026-05-06.

## Audiences

### Ops / Admin
Internal team members (devs, admins, operations staff).

- **Can trigger:** Any active orchestration
- **Can see:** All runs, all run steps, all tool calls, all artifacts, all approvals, all errors
- **Can act:** Retry failed runs, cancel in-flight runs, resolve stuck approvals, manage orchestration definitions
- **Auth:** Supabase Auth (email/password or SSO). Role claim: `ops` in JWT.

### End User (Staff)
Non-technical staff who trigger specific orchestrations and track their own submissions.

- **Can trigger:** Only orchestrations they have access to (defined in `orchestration_access` join table)
- **Can see:** Only their own runs (`triggered_by = auth.uid()`), plus runs they've been asked to approve
- **Can act:** Approve / reject items in their approval inbox
- **Auth:** Supabase Auth (email/password or SSO). Role claim: `enduser` in JWT.

### Runtime (Workers)
Not a human — the Cloudflare Worker runtime.

- **Auth:** Supabase service role key (bypasses RLS intentionally)
- **Scope:** Full read/write on all orchestration schema tables
- **Key storage:** Wrangler secret `SUPABASE_SERVICE_ROLE_KEY`. Never exposed to the dashboard or end users.

---

## Role detection

Role is stored in the Supabase Auth user metadata and surfaced in the JWT via a custom claim. The dashboard reads `user.role` to select which view to render.

```sql
-- Set role on user creation (or via admin action)
update auth.users
set raw_user_meta_data = jsonb_set(raw_user_meta_data, '{role}', '"ops"')
where id = '<user-id>';
```

Custom JWT hook (Supabase) propagates `role` into the JWT claim so RLS policies can read `auth.jwt() -> 'role'`.

---

## RLS summary

| Table | Ops | End User | Runtime |
|-------|-----|----------|---------|
| `orchestrations` | read/write | read (active + access-listed) | read/write |
| `orchestration_access` | read/write | read own | read/write |
| `runs` | read/write all | read own + approval-assigned | read/write |
| `run_steps` | read all | read (if parent run visible) | read/write |
| `tool_calls` | read all | read (if parent run visible) | read/write |
| `artifacts` | read all | read (if parent run visible, non-ops-only) | read/write |
| `approvals` | read/write all | read + update own (`requested_from`) | read/write |

---

## Login flow

1. Dashboard loads → check Supabase session
2. No session → redirect to `/login`
3. Login via email/password (Supabase Auth)
4. On success → read `user.user_metadata.role`
5. `role === 'ops'` → render ops layout
6. `role === 'enduser'` → render end-user layout
7. Unknown role → show error, contact admin

---

## Phase 1 setup tasks

- [ ] Enable Supabase Auth on the Lumiture project
- [ ] Configure custom JWT hook to propagate `role` claim
- [ ] Create initial ops user (Arun)
- [ ] Write RLS policies alongside each migration
- [ ] Test RLS with both an ops JWT and an end-user JWT before merging any schema change
