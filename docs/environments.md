# Environments & Promotion

How code gets from a PR to production. Introduced by [#121](https://github.com/LumitureLabs/LumiAgents/issues/121). Last updated: 2026-08-04.

Before #121, a merge to `main` applied Supabase migrations to the production project and redeployed the production Workers, automatically, with no environment in between. Two people push to this repo and the Tier 2 agent builder can open PRs. This document describes the two-environment model that replaced that.

---

## The model in one picture

```
 PR  ──► CI (typecheck / lint / tests)  ──►  merge to main
                                                  │
                                                  │  automatic
                                                  ▼
                                        ┌──────────────────────┐
                                        │      STAGING         │
                                        │  staging Supabase    │
                                        │  *-staging Workers   │
                                        │  migrations + smoke  │
                                        └──────────────────────┘
                                                  │
                                                  │  MANUAL — a human runs the
                                                  │  workflow from the Actions tab
                                                  ▼
                                        ┌──────────────────────┐
                                        │     PRODUCTION       │
                                        │  cuaknazkpmwvnkmwtamp│
                                        │  lumiagents-* Workers│
                                        │  migrations + smoke  │
                                        │  + E2E               │
                                        └──────────────────────┘
```

**Rules:**

1. All work lands on `main` through a PR. CI (`ci.yml`) runs typecheck, lint and unit tests on the PR, exactly as before.
2. **Every merge to `main` deploys to staging automatically** (`deploy-staging.yml`). Staging is a real environment — its own Supabase project, its own Workers — so every change is exercised somewhere before it can reach customers.
3. **Production only ever deploys when a human clicks "Run workflow".** There is no push trigger on the production workflows. This is the gate.

There is no `staging` *branch*. The original issue proposed one; we deploy `main` to staging instead, because a long-lived branch that must be merged forward creates exactly the conflict-and-drift problem the issue is trying to solve, and with two committers the extra branch buys nothing that "main is staging, prod is a button" doesn't.

### Why the gate lives in the deploy pipeline, not in GitHub

The obvious way to gate production is GitHub **branch protection** (require a PR, require passing CI, no direct pushes to `main`) or the newer **rulesets**. Neither is available to us: the LumitureLabs org is on the **GitHub Free plan** and this repo is **private**, and on Free, branch protection and rulesets are only offered on public repos. So the rule cannot be enforced at the git layer at all.

The substitute is to move the gate one step later, into the deploy pipeline: pushing to `main` can no longer touch production, because nothing but a manual `workflow_dispatch` deploys production. Someone can still push directly to `main` — and that push will go to staging — but they cannot ship to customers without deliberately opening the Actions tab and running the production workflow.

**What upgrading to GitHub Team (~$4/user/month) would add:**

- Branch protection / rulesets on private repos: require a PR before merging, require approving reviews, require CI status checks to pass, block force-pushes and deletion of `main`, require linear history.
- **Environments with required reviewers** — the proper version of this gate: a `production` GitHub Environment that pauses the deploy job until a named approver clicks Approve, with an audit trail, plus environment-scoped secrets so the production Supabase and Cloudflare credentials are only readable by production jobs.
- CODEOWNERS enforcement (auto-request review from the right person).

If we upgrade, keep the manual dispatch and add a `production` environment with required reviewers on top of it; then add branch protection so direct pushes to `main` stop too.

---

## What lives where

| | Staging | Production |
|---|---|---|
| Deployed by | `.github/workflows/deploy-staging.yml` (auto, on push to `main`) | `deploy-worker.yml` / `deploy-dashboard.yml` (manual `workflow_dispatch`) |
| Supabase project | secret `STAGING_SUPABASE_PROJECT_REF` (**not yet provisioned**) | `cuaknazkpmwvnkmwtamp` |
| Runtime Worker | `lumiagents-runtime-staging` | `lumiagents-runtime` |
| Agent Workers | `lumiagents-{angie,beady,patch,money,cleo,dewey}-staging` | `lumiagents-{angie,beady,patch,money,cleo,dewey}` |
| How agent Workers are found | Both deploy jobs **glob `runtime/workers/*/wrangler.toml`** (agent Workers first, runtime last) rather than listing the six by hand — so an agent Worker generated by the Tier 2 agent builder deploys with no workflow edit. Adding an agent means adding its `wrangler.toml` (with an `[env.staging]` block) and nothing else. | same |
| Dashboard Worker | `lumiagents-dashboard-staging` | `lumiagents-dashboard` |
| Cloudflare Workflow | `orchestration-workflow-staging` | `orchestration-workflow` |
| `ENVIRONMENT` var | `staging` | `production` |
| Runtime URL | secret `STAGING_RUNTIME_URL` | secret `NEXT_PUBLIC_RUNTIME_URL` |
| Post-deploy checks | health + orchestration catalogue | health + catalogue + vault webhook, then the full E2E suite |

Both environments live in the **same Cloudflare account** and are separated by Worker name via wrangler [named environments](https://developers.cloudflare.com/workers/wrangler/environments/). Staging config is purely additive: every `[env.staging]` block sits at the bottom of the existing `wrangler.toml`, and the production config above it is byte-identical to what it was.

Note that wrangler does **not** inherit `vars`, `services`, `workflows`, `ai` or `triggers` into a named environment — each is restated in full inside `[env.staging]`. If you add a binding or a var to production, you must add it to `[env.staging]` too or staging will silently run without it.

`SUPABASE_URL` in the `[env.staging.vars]` blocks is a deliberate placeholder (`https://STAGING-PROJECT-REF.supabase.co`). The staging project ref is not in the repo; CI injects the real value at deploy time with `wrangler deploy --env staging --var SUPABASE_URL:$STAGING_SUPABASE_URL`.

---

## Required GitHub Actions secrets

Repo → Settings → Secrets and variables → Actions.

### Already set (production + shared)

| Secret | Used by |
|---|---|
| `CLOUDFLARE_API_TOKEN` | all deploys (shared between staging and prod) |
| `CLOUDFLARE_ACCOUNT_ID` | all deploys (shared) |
| `SUPABASE_ACCESS_TOKEN` | `supabase link` / `db push` for **both** projects — a personal access token is account-scoped, so the same one works for staging |
| `NEXT_PUBLIC_RUNTIME_URL` | prod runtime URL — smoke tests, E2E, dashboard build |
| `NEXT_PUBLIC_SUPABASE_URL` | prod dashboard build + E2E |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | prod dashboard build + E2E |
| `DASHBOARD_URL` | prod dashboard smoke test |
| `E2E_OPS_EMAIL` / `E2E_OPS_PASSWORD` | prod E2E login |
| `SUPABASE_JWT_SECRET` | (present; not referenced by the workflows) |

### New — must be added to light up staging

| Secret | Value | Notes |
|---|---|---|
| `STAGING_SUPABASE_PROJECT_REF` | e.g. `abcd…` (20 chars) | The staging project's ref from its Supabase dashboard URL. **Do not** guess or reuse the prod ref. |
| `STAGING_SUPABASE_URL` | `https://<ref>.supabase.co` | Injected into every staging Worker via `--var`, and into the staging dashboard build. |
| `STAGING_SUPABASE_ANON_KEY` | staging project anon/publishable key | Staging dashboard build only. |
| `STAGING_RUNTIME_URL` | `https://lumiagents-runtime-staging.<subdomain>.workers.dev` | Read it off the first successful staging Worker deploy. Also used by the staging smoke test. |

Until **all four** exist, `deploy-staging.yml` skips (see below) rather than failing.

### Cloudflare Worker secrets (not GitHub secrets)

These are set directly on the staging Workers with wrangler, and must be **staging-specific values** — never copy production's `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_JWT_SECRET` into staging, or a staging bug can write to the production database.

```bash
cd runtime

# Runtime Worker (staging)
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging   # from the STAGING project
wrangler secret put SUPABASE_JWT_SECRET       --env staging   # from the STAGING project
wrangler secret put ANTHROPIC_API_KEY         --env staging

# Everything else the runtime reads; see the comment block at the top of
# runtime/wrangler.toml for the authoritative list and what each one is for:
#   N8N_WEBHOOK_SECRET, APOLLO_API_KEY, JIRA_EMAIL, JIRA_API_TOKEN,
#   SAM_GOV_API_KEY, TEAMS_INCOMING_WEBHOOK_URL, TEAMS_BOT_APP_ID,
#   TEAMS_BOT_APP_SECRET, GITHUB_API_TOKEN, GITHUB_WEBHOOK_SECRET,
#   RESEND_API_KEY, RESEND_FROM, TAVILY_API_KEY, ALERT_EMAIL,
#   SBIR_API_BASE, N8N_QUEUE_ENABLED,
#   MSGRAPH_TENANT_ID, MSGRAPH_CLIENT_ID, MSGRAPH_CLIENT_SECRET

# Each agent Worker (staging)
for a in angie beady patch money cleo dewey; do
  wrangler secret put ANTHROPIC_API_KEY --config workers/$a/wrangler.toml --env staging
done
```

### ⚠️ Deliberately withheld from staging — do not "fix" these

Staging shares a Cloudflare account and the same *external* SaaS systems as production.
Several integrations **write to the real world**, and there is no staging copy of the thing
they write to. Giving staging production credentials for these does not make staging more
useful — it makes staging able to damage production.

**As of 2026-08-05 staging intentionally has only three Worker secrets:**
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `ANTHROPIC_API_KEY` (all staging-specific).

Everything below is **deliberately unset**. Each one fails closed — the feature errors in
staging, which is the intended behaviour. If you are tempted to add one because "the tab is
broken in staging", that broken tab is the safety mechanism working:

| Secret | What staging would do to PRODUCTION if given it |
|---|---|
| `GITHUB_API_TOKEN` | The Knowledge Base editor `PUT`s to `/repos/{VAULT_OWNER}/{VAULT_REPO}/contents/...` (`runtime/src/routes/vault.ts`). Staging's `VAULT_REPO` points at the real `LumitureLabs/LumiKnowledge`, so **editing a note in staging commits to the production vault.** |
| `MSGRAPH_TENANT_ID` / `_CLIENT_ID` / `_CLIENT_SECRET` + `CONTENT_CALENDAR_*` | The content-calendar sync writes cells into the **real** Excel workbook on the Lumiture Labs SharePoint site. |
| `RESEND_API_KEY` / `RESEND_FROM` / `ALERT_EMAIL` | **Sends real email to real people** — digests, alerts, approval requests. |
| `JIRA_EMAIL` / `JIRA_API_TOKEN` | Creates and transitions **real Jira tickets**. |
| `GH_APP_ID` / `GH_APP_INSTALLATION_ID` / `GH_APP_PRIVATE_KEY` | The Tier 2 agent builder opens **real pull requests** against this repo. |
| `TEAMS_*` | Posts into **real Teams channels**. |
| `SAM_GOV_API_KEY` / `TAVILY_API_KEY` / `APOLLO_API_KEY` | No write risk, but burns the **shared production API quota/budget**. |
| `GITHUB_WEBHOOK_SECRET` | The production vault webhook points at the production runtime. Do not add a second webhook on `LumiKnowledge` for staging. |
| `N8N_QUEUE_ENABLED` | Staging would drain the **production** n8n call queue. |

**If you genuinely need one of these exercised in staging**, do not copy the production
credential. Instead give staging its own isolated target:

- Vault → fork to a `LumiKnowledge-staging` repo and repoint `VAULT_REPO` in
  `[env.staging.vars]`, with a token scoped to that fork only.
- Email → a Resend test key with a non-customer-facing `RESEND_FROM`.
- Graph/content calendar → a separate throwaway workbook and its own app registration.
- Jira → a sandbox project.

Staging exists to validate **code, migrations and deploys** — not to exercise live
third-party writes. Keep it that way.

---

## Runbook: provisioning the staging Supabase project

This is out-of-band, one-time, and has to be done by a human with Supabase org access. Until it is done, `deploy-staging.yml` skips.

### 1. Create the project

Supabase dashboard → New project.

- Org: same as production. Name: `lumiagents-staging`.
- Region: **same as production** so timing/latency behaviour matches.
- Generate a strong DB password; store it in the team password manager.
- Postgres major version **17** (matches `supabase/config.toml`'s `[db] major_version = 17`).

Record the project ref from the dashboard URL (`https://supabase.com/dashboard/project/<ref>`).

### 2. Apply the migrations

Migrations are **forward-only**; the staging project starts empty and replays all of them from scratch.

> **The chain does not replay against an empty project on its own.** Run `supabase/bootstrap-fresh-project.sql` first. See [Rebuilding the database from scratch](#rebuilding-the-database-from-scratch) below — it is the authoritative procedure and this step is a summary of it.

```bash
export SUPABASE_ACCESS_TOKEN=<your personal access token>
# 0. Set exposed schemas, then run supabase/bootstrap-fresh-project.sql in the SQL Editor.
supabase link --project-ref <staging-ref>
supabase db push --yes    # expect to run this more than once
```

Watch out for these on this first run:

- `supabase/config.toml` pins `project_id = "cuaknazkpmwvnkmwtamp"`. `supabase link` may report config drift against the staging project. `db push` uses the *linked* ref, not `project_id`, so this is informational — but read the output rather than skipping past it, and **do not** commit a changed `project_id`.
- Any extension the production project enabled by hand (rather than in a migration) has to be enabled on staging by hand too. If `db push` fails on a missing extension, enable it in Database → Extensions and re-run.
- The CLI applies migrations in **batches**, not all in one transaction. A `db push` that stops part-way has still committed everything before the failing migration, and a clean `db push` may need several consecutive runs before it reports nothing left to apply. Keep running it until it says so.

`supabase/seed.sql` is **not** applied by `db push`. Apply it manually if staging needs the seed data.

### 3. Enable the JWT access-token hook

The migrations create `public.custom_access_token_hook`, `public.is_ops()` and `public.is_enduser()` and grant execute to `supabase_auth_admin` — but *enabling* the hook is a project setting, not schema, so it does not travel with `db push`. Production has it on; staging will not until you do this:

Staging dashboard → **Authentication → Hooks → Customize Access Token (JWT) Claims** → enable → select `public.custom_access_token_hook` → Save.

Verify:

```sql
-- should return the function
select proname from pg_proc where proname = 'custom_access_token_hook';
-- should return true for is_ops/is_enduser existing
select proname from pg_proc where proname in ('is_ops','is_enduser');
```

Skipping this step is the classic staging failure mode here: everything looks fine until an ops user logs into the staging dashboard and RLS denies them everything, because `is_ops()` reads a `user_role` claim the hook never wrote.

### 4. Create ops users on staging

`20260514000004_set_ops_app_metadata.sql` back-fills `app_metadata.role = 'ops'` for users that already exist; on a brand-new project there are none, so accounts created afterwards need the role set explicitly.

Staging dashboard → Authentication → Users → Add user (email + password), then:

```sql
update auth.users
set raw_app_meta_data = raw_app_meta_data || '{"role":"ops"}'::jsonb
where email = '<staging-ops-user@…>';
```

The user must sign out and back in to pick up a JWT containing the claim.

Also set **Authentication → URL Configuration → Site URL** to the staging dashboard (`https://lumiagents-dashboard-staging.<subdomain>.workers.dev`) and add it to the redirect allow-list, or staging logins will bounce to the production dashboard.

### 5. Set the GitHub secrets and the Worker secrets

Add the four `STAGING_*` GitHub secrets from the table above, and run the `wrangler secret put --env staging` block.

Chicken-and-egg on `STAGING_RUNTIME_URL`: you don't know the URL until the Worker exists. Either (a) set the three other secrets, run the staging workflow once — it will skip — then deploy the staging runtime manually with `cd runtime && pnpm exec wrangler deploy --env staging --var SUPABASE_URL:<staging url>` to learn the URL; or (b) predict it from your account's `workers.dev` subdomain, which is the same one production uses. Then add `STAGING_RUNTIME_URL` and re-run.

### 6. Prove it works

Actions → **Deploy Staging (auto)** → Run workflow. It should go green through `smoke-test-staging`, and the health check asserts `environment == "staging"` — which is also the guard that catches `STAGING_RUNTIME_URL` accidentally pointing at production.

---

## Rebuilding the database from scratch

**The finding: `supabase/migrations/` cannot rebuild this database from nothing.**

This was discovered standing up the staging Supabase project. Replaying all 77 migrations against a brand-new, empty project does not work — it fails, gets fixed, and fails again, seven times over. The reason is that the chain was written against a database that already existed. The n8n-era schema — `public.users`, `opportunities`, `assessments`, the finance and résumé tables, a trigger function — was built by hand in the Supabase dashboard and **never captured in a migration**. The earliest migrations `ALTER` it, enable RLS on it, and hang foreign keys off it. Nothing creates it.

Treat this as a **disaster-recovery gap, not staging friction**. If the production project were lost, this repository could not reconstruct it. `supabase/bootstrap-fresh-project.sql` is what closes the gap: an idempotent script that recreates just enough of the pre-migration schema for the chain to replay. It is deliberately **not** a migration and must never be moved into `supabase/migrations/` — it describes the state the chain assumes, and the CLI must not record it as applied.

### Troubleshooting: the failures, in the order they occur

Every row here is a real error from a real empty-project replay. All of them are handled by the bootstrap script; the table is here so the errors are recognisable if you hit a *new* one of the same species.

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | `20260506000002_supabase_auth_migration.sql` → `ERROR: relation "public.users" does not exist` | The legacy `public.users` table (`user_id, firstname, lastname, email, role, is_active, username, password, created_at`) predates migrations. `20260724000003` later drops it, so it exists only *inside* the chain. | Bootstrap creates it. |
| 2 | `20260506000004_prune_and_harden.sql` → `ERROR: relation "public.opportunities" does not exist`, then the same for ~20 more | That migration enables RLS on the whole n8n-era table set: `assessments, budget_lines, candidates, capability_statements, company_profiles, contracts, employees, icp_profiles, incumbent_research, indirect_rates, invoices, labor_records, opportunities, opportunity_documents, past_performance, prompt_bank, resume_jobs, resume_queue, resume_results, staff_requests` — plus the two retired vector stores `opportunity_documents_vt` and `past_performance_vt`, which **no longer exist in production at all** (`20260724000001` drops them). None are created by any migration. | Bootstrap creates all 22. |
| 3 | `ERROR: there is no unique constraint matching given keys for referenced table "opportunities"` | A bootstrapped table without a PRIMARY KEY can't be the target of the FK a later migration adds (`202605080911` → `govcon_assessments.opportunity_id REFERENCES public.opportunities(id)`). | Bootstrap declares `opportunities.id` as PRIMARY KEY (and gives every legacy table a PK). |
| 4 | `ERROR: constraint "opportunities_source_check" of relation "opportunities" does not exist` | `20260506000005` creates that CHECK as a side effect of `ADD COLUMN IF NOT EXISTS source … CHECK (…)`. If `source` already exists, Postgres skips the whole action **including the CHECK** — and `20260530000001` then does an *unguarded* `DROP CONSTRAINT opportunities_source_check`. | Bootstrap adds the constraint explicitly, with the original 3-value list (`manual, sam_gov, govcon_api`); `20260530000001` is what adds `sbir`. |
| 5 | `ERROR: function public.set_updated_at() does not exist` | A legacy trigger function. `20260506000005` attaches it to three tables; no migration defines it. (`orchestration.set_updated_at()` is a different, properly-migrated function.) | Bootstrap creates it. |
| 6 | `20260524000001_resume_native_scoring.sql` → `ERROR: column "leadership_and_inititative_score" does not exist` | That migration *fixes a typo*: it renames `resume_results.leadership_and_inititative_score` → `…initiative…`. A bootstrap seeded from production's **current** schema already has the corrected name, so the rename has nothing to rename. | Bootstrap creates the column with the **original typo'd spelling**. This is load-bearing; do not "fix" it in the bootstrap script. |
| 7 | `20260709000002_knowledge_corpus_sensitivity.sql` → `ERROR: type extensions.vector does not exist` | A new Supabase project installs `vector` into `public`; production has it in `extensions`. Two earlier migrations (`20260506000003`, `20260624000002`) reference the type by **bare** name, and one later migration references `extensions.vector`. `db push` runs with a search_path that excludes `extensions`. | `ALTER EXTENSION vector SET SCHEMA extensions;` — in the bootstrap, guarded, together with appending `extensions` to the migration role's `search_path` so the bare references still resolve. See the ordering note in section 0 of the script if you prefer not to touch `search_path`. |

The general shape: **`ADD COLUMN IF NOT EXISTS … CHECK (…)` is a trap.** If the column exists, the constraint silently doesn't get created, and a later unguarded `DROP CONSTRAINT` blows up. Rows 4 and 6 are both versions of "the bootstrap must reproduce the schema as it was *before* the chain ran, not as it is *now*".

### Procedure

1. **Create the project.** Same org, same region as production, Postgres major version **17** (matches `[db] major_version` in `supabase/config.toml`). Record the project ref.
2. **Set the exposed schemas** — Project Settings → API → *Exposed schemas* → `public, graphql_public, orchestration`. Do this **before** anything else; see below for why it matters.
3. **Run the bootstrap.** SQL Editor → paste `supabase/bootstrap-fresh-project.sql` → Run. Or `psql "$DATABASE_URL" -f supabase/bootstrap-fresh-project.sql`. It is idempotent and safe to re-run at any point.
4. **Link and push.**
   ```bash
   export SUPABASE_ACCESS_TOKEN=<personal access token>
   supabase link --project-ref <ref>
   supabase db push --yes
   ```
   **Run `db push` repeatedly until it reports nothing left to apply.** The CLI applies migrations in batches rather than in one transaction, so a single invocation routinely stops early even when nothing is wrong. If it stops on an *error*, everything before the failing migration is already committed — fix, re-run, and it picks up where it left off.
5. **Enable the JWT access-token hook** — Authentication → Hooks → *Customize Access Token (JWT) Claims* → enable → `public.custom_access_token_hook` → Save.
6. **Create ops users** — add them in Authentication → Users, then set the role:
   ```sql
   update auth.users
   set raw_app_meta_data = raw_app_meta_data || '{"role":"ops"}'::jsonb
   where email = '<ops-user@…>';
   ```
   They must sign out and back in to get a JWT with the claim. Also set Authentication → URL Configuration → Site URL and the redirect allow-list for that environment's dashboard.

### The settings that do NOT travel with `db push`

All of these are **project settings, not schema**. `db push` will never create them, nothing in the repo will tell you they are missing, and each breaks the app in a different, non-obvious way.

**1. Exposed schemas (`public, graphql_public, orchestration`).**
A new project exposes `public, graphql_public` only. `orchestration` is where essentially the entire platform lives — orchestrations, runs, run_steps, tool_calls, artifacts, approvals, documents. Leave it off and PostgREST returns `PGRST106` / "The schema must be one of the following" for every dashboard and runtime query against it. The database is *correct*; the API in front of it refuses to serve it. Note that `supabase/config.toml`'s `[api] schemas` applies to the **local** stack only — it does not configure a hosted project.

**2. The Auth access-token hook.**
The migrations create `public.custom_access_token_hook`, `public.is_ops()` and `public.is_enduser()` and grant execute to `supabase_auth_admin` — but *turning the hook on* is a project setting. Without it, JWTs carry no `user_role` claim, so `is_ops()` is false for everyone, so every ops policy denies. Login works, the session is valid, and the app is simply empty everywhere. This is the classic failure mode: it looks like a data problem and it is a settings problem.

**3. Auth URL configuration (`site_url` + redirect allow-list).**
A new project ships with `site_url = http://localhost:3000` and an empty allow-list. Invite and password-reset links are built from `site_url`, so on a fresh environment they point at localhost and the redirect is refused. Set both to that environment's dashboard origin.

**4. Signup must be disabled.**
LumiAgents is invite-only, but a new Supabase project allows open signup by default. Leave it on and anyone who can reach the anon key can create themselves an account. Set `disable_signup = true`.

**5. Invite/OTP lifetime (`mailer_otp_exp`).**
Defaults to **3600 (1 hour)**. There is no SMTP on these projects, so invites are copy-paste links pasted into Teams — and a link that dies in an hour routinely expires before the recipient opens it. Both environments are set to **86400 (24h)**. Symptom when it is wrong: the invitee clicks the link and lands on `/login` with no explanation, because `verifyOtp` fails and the confirm route redirects there.

These four are all reachable from the Management API, e.g.:

```bash
curl -X PATCH "https://api.supabase.com/v1/projects/$REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"disable_signup":true,"site_url":"https://<dashboard-origin>","uri_allow_list":"https://<dashboard-origin>/**","mailer_otp_exp":86400}'
```

Quick verification after a rebuild:

```sql
-- schema replayed to HEAD?
select count(*) from supabase_migrations.schema_migrations;   -- expect 77 (as of 2026-08-04)

-- hook + helpers present?
select proname from pg_proc
where proname in ('custom_access_token_hook','is_ops','is_enduser','set_updated_at');

-- vector in the right schema?
select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'vector';                                    -- expect 'extensions'

-- typo fixed by 20260524000001?
select column_name from information_schema.columns
where table_name = 'resume_results' and column_name like 'leadership%';
                                                               -- expect leadership_and_initiative_score
```

Then sign in as an ops user and confirm the dashboard lists orchestrations. That single check exercises the exposed schemas *and* the hook at once.

### Keeping the gap from getting worse

- New migrations must not deepen the assumption. Guard anything that touches a legacy object: `IF EXISTS` / `IF NOT EXISTS` on drops and adds, `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`.
- If a migration must depend on a legacy table's shape, add that shape to `bootstrap-fresh-project.sql` in the same PR.
- The bootstrap script is minimal on purpose. It creates the columns the migrations actually touch, not production's real legacy column lists, which are not recoverable from this repo. That is fine — these tables are vestigial, several are dropped by the chain itself, and no application code reads them. It is *not* fine if someone starts writing to one.

---

## How the "staging not configured" skip works

The staging Supabase project does not exist yet, and `main` must not go red because of infrastructure nobody has built. So `deploy-staging.yml` opens with a `preflight` job that reads the four `STAGING_*` secrets into env vars and emits a single boolean output, `configured`. Every subsequent job carries `if: needs.preflight.outputs.configured == 'true'`.

When a secret is missing, `preflight` succeeds, writes a job summary naming exactly which secrets are absent and pointing at this document, emits a `::notice::` annotation, and sets `configured=false`. The five downstream jobs are then **skipped**, and the workflow run is green.

Two implementation details worth knowing before you edit this file:

- **`secrets` cannot be referenced in a job-level `if:`** in GitHub Actions. That is why the check is a job that resolves secrets in a step's `env:` block and exports an output, rather than an `if: secrets.STAGING_… != ''` on each job.
- Empty output means false. If you add a fifth staging secret, add it to `preflight` too — otherwise the workflow will run and fail at the point of use instead of skipping cleanly.

Once the secrets exist, nothing needs to change: the next push to `main` deploys.

---

## Promoting to production

Two workflows, run independently — promote whichever surfaces your change touched. Both are manual.

**Runtime + agent Workers + DB migrations:**

1. Actions → **Deploy Worker (PRODUCTION — manual)** → *Run workflow*.
2. `ref` defaults to `main`. Leave it, or enter a branch, tag or commit SHA to promote a specific commit (this is also how you roll back — see below).
3. Run. The pipeline is unchanged from the old auto-deploy: typecheck → migrate against `cuaknazkpmwvnkmwtamp` → the six agent Workers, then the runtime → smoke test (health, orchestration catalogue, vault webhook HMAC) → full E2E suite.

**Dashboard:**

Actions → **Deploy Dashboard (PRODUCTION — manual)** → *Run workflow* → same `ref` input. typecheck → OpenNext build → deploy → smoke test.

Both workflows carry a `concurrency` group (`deploy-production-worker` / `deploy-production-dashboard`), so a second promote queues behind the first instead of racing it into the same migrations and Workers.

**Order when both changed:** promote the worker first, then the dashboard. The dashboard's smoke test asserts the runtime is healthy, and the runtime's `ALLOWED_ORIGINS` is what lets the dashboard call it.

**Before you promote,** confirm the commit you are promoting went green on staging: Actions → Deploy Staging (auto) → find the run for that SHA.

---

## Rolling back

Deploys are ref-driven, so a rollback is just a promote of an older ref.

1. Find the last-known-good commit SHA on `main` (`git log --oneline`, or the Actions run that last deployed cleanly).
2. Actions → **Deploy Worker (PRODUCTION — manual)** → Run workflow → `ref` = that SHA → Run.
3. Same for the dashboard if it is implicated.

**Migrations do not roll back.** They are forward-only by policy, and `supabase db push` only applies what has not run. Re-running an older ref redeploys the old *code* against the *current* schema. So:

- Schema changes must be backward-compatible with the previous release — add columns, don't rename or drop them in the same PR that starts using the new shape. Ship the additive migration, promote, then remove the old path in a later change.
- If a migration itself is the problem, fix it forward: write a new migration that corrects the state, merge it, let staging apply it, then promote. Never edit an applied migration.

If a promote is actively breaking production and you need the previous Worker back *right now*, Cloudflare's dashboard (Workers → the Worker → Deployments) can roll back to a previous version immediately; then follow up with a proper ref-based promote so the repo and the deployed code agree again.

---

## Known gaps

- **Agent-builder-generated Workers.** The Tier 2 agent builder (`runtime/src/agent-builder/tier2/generate-agent.ts`) writes a `wrangler.toml` with a production `[vars]` block only. A newly generated agent Worker therefore has no `[env.staging]` and will not be deployed to staging until someone adds one by hand (copy the block from any `runtime/workers/*/wrangler.toml`). The generator should learn to emit it; that is application code and out of scope for #121.
- **No staging E2E.** Staging runs the smoke test only. The E2E suite needs an ops account and credentials (`E2E_OPS_EMAIL` / `E2E_OPS_PASSWORD`); add `STAGING_E2E_*` equivalents and a staging E2E job once staging has ops users.
- **`wrangler deploy` with no `--env` now warns.** Because `wrangler.toml` defines environments, the production deploy step prints "Multiple environments are defined… no target environment was specified" and deploys the top-level (production) config. That is correct behaviour and the production commands were deliberately left untouched; passing `--env=""` would silence it and is verified to produce identical bindings, if the noise ever bothers anyone.
- **Shared Cloudflare API token.** Staging and production deploy with the same `CLOUDFLARE_API_TOKEN`. A GitHub Team upgrade with environment-scoped secrets is the clean fix.
- **The n8n-era schema is still not in the migration chain.** `supabase/bootstrap-fresh-project.sql` makes a from-scratch rebuild *possible* (see [Rebuilding the database from scratch](#rebuilding-the-database-from-scratch)), but it is a hand-maintained side file, not something CI exercises, and it reproduces only the columns the migrations touch. The real fixes, in increasing order of effort: (a) a CI job that provisions a throwaway project and replays bootstrap + all migrations, so this rots loudly instead of silently; (b) capture the legacy tables' true shapes from a production dump; (c) squash the chain into a single baseline migration taken from production and retire the bootstrap entirely. Until then, a rebuild is a documented manual procedure, and it is only verified as far as the last person who ran it.
