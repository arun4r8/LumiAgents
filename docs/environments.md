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

Judgement calls worth making deliberately when provisioning staging secrets:

- **Leave `N8N_QUEUE_ENABLED` unset in staging** unless you are specifically testing the queue drainer — staging should not drain the production n8n call queue.
- **Point `RESEND_FROM` at a non-customer-facing sender**, or leave `RESEND_API_KEY` unset, so staging never emails real recipients. `ALERT_EMAIL` likewise.
- **`GITHUB_WEBHOOK_SECRET` / vault sync**: the production GitHub webhook points at the production runtime. Do not add a second webhook to `LumiKnowledge` for staging unless you want staging writing to the vault repo.

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

```bash
export SUPABASE_ACCESS_TOKEN=<your personal access token>
supabase link --project-ref <staging-ref>
supabase db push --yes
```

Watch out for two things on this first run:

- `supabase/config.toml` pins `project_id = "cuaknazkpmwvnkmwtamp"`. `supabase link` may report config drift against the staging project. `db push` uses the *linked* ref, not `project_id`, so this is informational — but read the output rather than skipping past it, and **do not** commit a changed `project_id`.
- Any extension the production project enabled by hand (rather than in a migration) has to be enabled on staging by hand too. If `db push` fails on a missing extension, enable it in Database → Extensions and re-run.

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
