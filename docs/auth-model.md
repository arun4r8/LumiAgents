# Auth Model

Who logs into the dashboard, what they can see, and what they can trigger. Drives RLS policy design. Last updated: 2026-07-20.

Two roles are **enforced**: `ops` (full access) and `enduser` (own records only). Enforcement is belt-and-suspenders — Postgres RLS (via `public.is_ops()`, which reads the JWT) *and* runtime route guards (`requireOpsToken`) both gate access. Any other role string you see in orchestration `access` metadata (`role:analyst`, `role:hr`) is **declared but not enforced anywhere** — it is documentation-in-data, not a security boundary.

Agents have **no database identity**. Every agent and every orchestration step executes as the Supabase `service_role`, which bypasses RLS by design (the runtime is trusted). This is precisely why per-agent *knowledge* access (which corpus an agent may read, whether it may see `restricted` documents) is enforced in the runtime retrieval path — the `match_document_chunks` RPC arguments — and **not** in Postgres roles: at the database layer there is nothing to distinguish one agent from another.

## Audiences

### Ops / Admin
Internal team members (devs, admins, operations staff).

- **Can trigger:** Any active orchestration
- **Can see:** All runs, all run steps, all tool calls, all artifacts, all approvals, all errors
- **Can act:** Retry failed runs, cancel in-flight runs, resolve stuck approvals, manage orchestration definitions
- **Auth:** Supabase Auth, email + password. `app_metadata.role = 'ops'`, surfaced in the JWT (see Role detection). Runtime routes additionally verify this via `requireOpsToken`.
- **Current accounts:** 4 ops users.

### End User (Staff)
Non-technical staff who trigger specific orchestrations and track their own submissions.

- **Can trigger:** Only orchestrations they have access to (defined in `orchestration_access` join table)
- **Can see:** Only their own runs (`triggered_by = auth.uid()`), plus runs they've been asked to approve
- **Can act:** Approve / reject items in their approval inbox
- **Auth:** Supabase Auth, email + password. `app_metadata.role = 'enduser'`, surfaced in the JWT.
- **Current accounts:** none yet — the enduser path is built and enforced, but no enduser accounts have been provisioned.

### Runtime (Workers)
Not a human — the Cloudflare Worker runtime.

- **Auth:** Supabase service role key (bypasses RLS intentionally)
- **Scope:** Full read/write on all orchestration schema tables
- **Key storage:** Wrangler secret `SUPABASE_SERVICE_ROLE_KEY`. Never exposed to the dashboard or end users.
- **Agents:** all agents run inside this runtime as `service_role` — they have no DB identity of their own. Knowledge scoping is therefore enforced in the retrieval path, not by Postgres (see the note at the top).

---

## Role detection

Role is stored in the Supabase Auth **app_metadata** (not user_metadata — app_metadata is not user-editable) and surfaced in the JWT via a custom claim. The dashboard reads the role to select which view to render.

```sql
-- Set role on user creation (or via admin action)
update auth.users
set raw_app_meta_data = raw_app_meta_data || '{"role":"ops"}'::jsonb
where id = '<user-id>';
```

A custom Access Token Hook (`public.custom_access_token_hook`) copies `app_metadata.role` into a custom `user_role` JWT claim — deliberately *not* the top-level `role` claim, which PostgREST reserves for the Postgres role (`authenticated` / `anon` / `service_role`). RLS reads role through the `public.is_ops()` helper:

```sql
-- is_ops(): true when the caller is an ops user
select (auth.jwt() ->> 'user_role') = 'ops'
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'ops';
```

The runtime enforces the same check independently in `requireOpsToken`, which validates the bearer token against Supabase Auth and requires `app_metadata.role === 'ops'` (internally-minted `agent-dispatch` tokens are the only other accepted principal).

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
3. Login via email/password (Supabase Auth — no SSO configured)
4. On success → read the role from `app_metadata` (via the `user_role` JWT claim)
5. `role === 'ops'` → render ops layout
6. `role === 'enduser'` → render end-user layout
7. Unknown role → show error, contact admin

---

## Setup status

- [x] Enable Supabase Auth on the Lumiture project
- [x] Configure custom Access Token Hook to propagate the `user_role` claim
- [x] Create ops users — 4 provisioned
- [x] Write RLS policies alongside each migration (`public.is_ops()` gate)
- [x] Add the runtime `requireOpsToken` guard on ops-only routes
- [ ] Provision the first enduser account (path is built + enforced; none created yet)
- [ ] Continue testing RLS with both an ops JWT and an end-user JWT before merging any schema change
