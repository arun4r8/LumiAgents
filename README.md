# LumiAgents

Agent orchestration platform built on Cloudflare Workers and Supabase. Six AI agents (Angie, Beady, Cleo, Dewey, Patch, Money) expose company workflows as typed, auditable, resumable orchestrations through a Next.js dashboard.

## Architecture

| Layer | Technology | Purpose |
|---|---|---|
| **Dashboard** | Next.js → Cloudflare Workers | Ops + end-user interface: trigger runs, monitor, approve |
| **Runtime** | Cloudflare Workers + Workflows | Orchestration engine: step runner, LLM calls, retries, cron |
| **Data** | Supabase (Postgres + RLS) | Runs, steps, artifacts, domain tables; auth backbone |
| **Integrations** | Direct API wrappers (legacy n8n webhooks being phased out) | External systems wrapped as typed, idempotent tools |

The runtime routes agent chat requests via `AGENT_BINDINGS` in `runtime/src/routes/agents.ts`. Four agents (Angie, Beady, Patch, Money) run as their own Cloudflare Worker (`lumiagents-angie`, `lumiagents-beady`, etc.) reached over a Service Binding, so their metrics, logs, and deploys are isolated. Cleo and Dewey have no dedicated Worker: they run inline inside `lumiagents-runtime` via the fallback path (`if (workerBinding) {...} else { runAgentChat(...) }`).

```
Dashboard → lumiagents-runtime (gateway + orchestrations + cron)
                ↓ Service Bindings          ↳ inline (fallback path)
     lumiagents-angie  lumiagents-beady      Cleo  Dewey
     lumiagents-patch  lumiagents-money
```

## Agents

Angie, Beady, Patch, and Money each run as a dedicated Worker; Cleo and Dewey run inline in the runtime (see Architecture above).

| Agent | Domain | Key orchestrations |
|---|---|---|
| **Angie** | HR & Recruiting | candidate-sourcing, resume-formatting, resume-scoring |
| **Beady** | GovCon BD (discovery, scoring & response drafting) | opportunity-search, opportunity-sweep (parallel SAM + SBIR), sbir-topic-search, govcon-assessment, past-performance-seed, rfi-draft, industry-day-sweep |
| **Cleo** | Eminence, awards & content | award-sweep, award-report, content-plan, content-draft |
| **Dewey** | Knowledge librarian | knowledge-search, retag-document, knowledge-inventory |
| **Patch** | IT Ops & Knowledge | ticket-ops, staff-request, document-query |
| **Money** | Finance & Analytics | data-analyst, financial-report |

## Repo layout

```
/agents/              # Agent entrypoints and tool definitions
/orchestrations/      # Workflow definitions, one folder per orchestration
/integrations/        # Typed wrappers around external APIs (and legacy n8n webhooks, being phased out)
/runtime/             # Cloudflare Worker engine (routes, step runner, LLM primitives)
  src/
  workers/            # Wrangler configs for the dedicated agent Workers (angie, beady, patch, money)
/dashboard/           # Next.js app deployed via opennextjs-cloudflare
/supabase/
  migrations/         # Forward-only Supabase migrations (canonical location)
/docs/                # Architecture decisions and contracts (read before coding)
/.claude/             # Claude Code skills, agents, and slash commands
```

The `/agents/`, `/orchestrations/`, and `/integrations/` directories are TypeScript source bundled into the runtime Worker; they are **not** separate packages. Only `runtime/` and `dashboard/` are pnpm workspace packages.

## Local development

**Prerequisites:** Node 22+, pnpm 9+, [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/), [Supabase CLI](https://supabase.com/docs/guides/cli)

**1. Install**
```bash
git clone <repo-url>
cd LumiAgents
pnpm install
```

**2. Set up runtime secrets**
```bash
cp runtime/.dev.vars.example runtime/.dev.vars   # or copy the template comments as a guide
# Fill in values; see "Runtime secrets" table below
```

**3. Set up dashboard env**
```bash
cp dashboard/.env.local.example dashboard/.env.local   # or create manually
# Fill in values; see "Dashboard env vars" table below
```

**4. Start everything**
```bash
# All 5 workers in parallel (runtime + 4 agents):
cd runtime && pnpm dev:all

# Dashboard (separate terminal):
cd dashboard && pnpm dev
```

Dashboard runs at `http://localhost:3000`. Runtime at `http://localhost:8787`.

### Runtime secrets (`runtime/.dev.vars`)

| Key | Where to get it | Required |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API | Yes |
| `SUPABASE_JWT_SECRET` | Supabase → Settings → API | Yes |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | Yes |
| `JIRA_EMAIL` | Your Atlassian account email | Yes (Patch) |
| `JIRA_API_TOKEN` | Atlassian → Profile → Manage API tokens | Yes (Patch) |
| `SAM_GOV_API_KEY` | SAM.gov → Account → API keys | Yes (Beady) |
| `APOLLO_API_KEY` | Apollo.io → Settings → API | No (Angie sourcing) |
| `N8N_WEBHOOK_SECRET` | n8n → Settings → API | No (n8n calls work without it) |
| `TEAMS_INCOMING_WEBHOOK_URL` | Teams → channel connector URL | No (notifications) |
| `GITHUB_API_TOKEN` | GitHub → Settings → Developer settings → PAT | No (vault sync) |

Non-secret vars (`SUPABASE_URL`, `JIRA_BASE_URL`, `ENVIRONMENT`) are already set in `wrangler.toml` and don't need to go in `.dev.vars`.

### Dashboard env vars (`dashboard/.env.local`)

| Key | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://cuaknazkpmwvnkmwtamp.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API → anon key |
| `NEXT_PUBLIC_RUNTIME_URL` | `http://localhost:8787` (local) or prod URL (staging) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → right sidebar |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens |
| `CF_WORKER_SCRIPT_NAME` | `lumiagents-runtime` |

## Adding things

The `.claude/skills/` directory has step-by-step playbooks for common tasks:

- **New orchestration**: clone closest existing one in `/orchestrations/`, register in `/runtime/src/registry.ts`, add to agent tool list in `/agents/<name>/index.ts`, write a DB migration to insert it into `orchestration.orchestrations`
- **New integration**: add a typed wrapper in `/integrations/`, follow the `defineTool` pattern and include an idempotency key
- **New migration**: always add a new file in `supabase/migrations/`, never edit applied ones; include RLS policy in the same migration

When using Claude Code: plan mode (Shift+Tab) for schema changes, runtime/engine changes, or anything spanning more than 3 files.

## Deploying

Push to `main` and everything deploys automatically via GitHub Actions.

| Workflow | Triggers on | Steps |
|---|---|---|
| `deploy-worker.yml` | `runtime/`, `orchestrations/`, `integrations/`, `agents/`, `supabase/migrations/` | Typecheck → Apply DB migrations → Deploy Runtime + 4 agent Workers → Smoke test → E2E |
| `deploy-dashboard.yml` | `dashboard/` | Typecheck → Build (opennextjs-cloudflare) → Deploy to Cloudflare Workers → Smoke test |

Both workflows run typecheck before deploying. Migrations always run before Workers deploy so the schema is never behind the code.

### GitHub Actions secrets required

| Secret | Used by |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Both deploy workflows |
| `CLOUDFLARE_ACCOUNT_ID` | Both deploy workflows |
| `SUPABASE_ACCESS_TOKEN` | Migration step in `deploy-worker.yml` |
| `NEXT_PUBLIC_SUPABASE_URL` | Dashboard build |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Dashboard build |
| `NEXT_PUBLIC_RUNTIME_URL` | Dashboard build + runtime smoke tests |
| `DASHBOARD_URL` | Dashboard smoke test |
| `E2E_OPS_EMAIL` / `E2E_OPS_PASSWORD` | E2E test suite |

### Secrets on the deployed workers

Each Worker needs secrets set once via Wrangler (not environment variables):
```bash
# Runtime (do once, covers all orchestrations):
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name lumiagents-runtime
wrangler secret put SUPABASE_JWT_SECRET       --name lumiagents-runtime
wrangler secret put ANTHROPIC_API_KEY         --name lumiagents-runtime
# ... (see wrangler.toml comment for full list)

# Agent workers (each needs ANTHROPIC_API_KEY + SUPABASE_SERVICE_ROLE_KEY):
wrangler secret put ANTHROPIC_API_KEY         --name lumiagents-angie
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name lumiagents-angie
# repeat for beady, patch, money
```

## Read before coding

These docs contain decisions that should not be relitigated without discussion:

1. `docs/architecture.md`: the layer model, major technology choices and why
2. `docs/data-model.md`: Supabase schema (`orchestrations`, `runs`, `run_steps`, `tool_calls`, `artifacts`)
3. `docs/workflow-contract.md`: how an orchestration is defined; the `step`, `llm_decide`, `llm_extract` primitives
4. `docs/roadmap.md`: phases and what is in/out of scope

## Conventions

- **TypeScript everywhere.** No `any`. Use `zod` for runtime schemas.
- **Every tool is idempotent or carries an idempotency key.** Workers retry.
- **RLS-first.** New tables ship with RLS in the same migration.
- **No secrets in code.** Wrangler secrets for Workers, Supabase Vault for app-level secrets.
- **Migrations are forward-only.** Never edit an applied migration; add a new one.
- **No comments that describe what the code does.** Only comment *why* when it's non-obvious.
