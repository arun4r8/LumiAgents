# LumiAgents Platform Overview

_Prepared for leadership review — May 2026_

---

## What we built

LumiAgents is an **agent orchestration platform** that sits on top of our existing n8n automations and system integrations. Instead of one-off scripts or manually triggered flows, every AI-powered business process is now a **typed, auditable, resumable workflow** with LLM decision points embedded in it.

The platform has four layers:

| Layer | Technology | Purpose |
|---|---|---|
| **Runtime** | Cloudflare Workers + Cloudflare Workflows | Executes orchestrations durably; retries, survives crashes |
| **Data** | Supabase (Postgres + RLS + Realtime) | Stores every run, step, LLM call, and artifact; enforces access control |
| **Dashboard** | Next.js on Cloudflare Pages | Ops team interface — trigger runs, monitor, approve, configure |
| **Agents** | Anthropic Claude (claude-sonnet-4-6) | Four named agents that wrap orchestrations as tools for conversational use |

---

## Deployment & GitHub Integration

### How code ships

Two GitHub Actions workflows live in `.github/workflows/`:

**`deploy-worker.yml`** — fires on any push to `main` that touches `runtime/`, `orchestrations/`, or `integrations/`.
Steps: install → typecheck → `wrangler deploy` → runtime is live on Cloudflare Workers.

**`deploy-dashboard.yml`** — fires on any push to `main` that touches `dashboard/`.
Steps: install → `opennextjs-cloudflare build` → `opennextjs-cloudflare deploy` → dashboard is live on Cloudflare Pages.

Both workflows are **fully automatic** — merging to `main` is the deployment mechanism. No manual steps.

### Environments

- **Production** — default Cloudflare environment, `wrangler.toml` root config.
- **Development** — `[env.dev]` block in `wrangler.toml`; deploy with `wrangler deploy --env dev`.
- The dashboard reads `NEXT_PUBLIC_RUNTIME_URL` at build time to point at whichever runtime environment is relevant.

### GitHub secrets required in the repo

| Secret | Used by |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Both deploy workflows |
| `CLOUDFLARE_ACCOUNT_ID` | Both deploy workflows |
| `NEXT_PUBLIC_SUPABASE_URL` | Dashboard build |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Dashboard build |
| `NEXT_PUBLIC_RUNTIME_URL` | Dashboard build |

---

## The Four Agents

Each agent is a named AI persona with a system prompt and a set of tools that map directly to orchestrations. When you chat with an agent, it decides which orchestrations to invoke based on your request.

### Angie — HR & Recruiting

Angie handles candidate sourcing and resume management.

**Tools available to Angie:**
- `source_candidates` → triggers `angie/candidate-sourcing` (Apollo.io search, LLM scoring, human approval gate)
- `format_resume` → triggers `angie/resume-formatting` (parse and reformat resume for a target consulting role)

**Access:** Dashboard at `/agents/angie`

---

### Beady — GovCon Business Development

Beady monitors federal contract opportunities and assesses fit.

**Tools available to Beady:**
- `search_opportunities` → triggers `beady/opportunity-search` (SAM.gov search, LLM scoring, upserts to opportunities table)
- `assess_opportunity` → triggers `beady/govcon-assessment` (5-dimension go/no-go assessment via n8n)
- `seed_past_performance` → triggers `beady/past-performance-seed` (embeds records into RAG for future retrieval)

**Access:** Dashboard at `/agents/beady`

---

### Patch — IT Operations & Knowledge

Patch manages internal tickets, staff requests, and the company knowledge base.

**Tools available to Patch:**
- `create_ticket` / `search_tickets` / `update_ticket` → `patch/ticket-ops` (Jira CRUD)
- `staff_request` → `patch/staff-request` (HR project ticket + Teams notification)
- `query_documents` → `patch/document-query` (RAG search across ingested knowledge)

**Access:** Dashboard at `/agents/patch`

---

### Money — Finance & Data Analytics

Money answers financial questions and generates reports by running SQL against our finance tables.

**Tools available to Money:**
- `query_data` → `money/data-analyst` (natural language → SQL → execute → LLM interpretation)
- `generate_financial_report` → `money/financial-report` (multi-question analysis → executive markdown report)

**Access:** Dashboard at `/agents/money`

---

## Orchestrations Catalogue (13 total)

All orchestrations are managed from the dashboard at `/orchestrations`. Each can be triggered manually, via the agent chat, or on a cron schedule.

| Orchestration | Domain | What it does | Schedule |
|---|---|---|---|
| `angie/candidate-sourcing` | HR | Apollo.io search → LLM scoring → approval gate → outreach draft | Manual |
| `angie/resume-formatting` | HR | Parse resume → reformat for consulting target role | Manual |
| `beady/opportunity-search` | GovCon BD | SAM.gov search → LLM scoring → upsert opportunities | Weekly (Mon 8am) |
| `beady/govcon-assessment` | GovCon BD | Full 5-dimension go/no-go assessment | Manual |
| `beady/past-performance-seed` | GovCon BD | Embed past performance into RAG | Manual |
| `money/data-analyst` | Finance | NL question → SQL → execute → interpret | Manual |
| `money/financial-report` | Finance | Multi-question analysis → executive report | Manual |
| `patch/inbound-triage` | IT/Ops | Classify inbound message → route to Teams or approval | Event-driven |
| `patch/ticket-ops` | IT/Ops | Create / update / search Jira tickets | Manual |
| `patch/staff-request` | IT/Ops | Log staff request → Jira ticket → Teams alert | Manual |
| `patch/vault-sync` | IT/Ops | Sync Obsidian vault (GitHub) into RAG knowledge base | GitHub webhook |
| `patch/document-ingest` | IT/Ops | Chunk, embed, store a document in RAG | Manual |
| `patch/document-query` | IT/Ops | RAG search across all ingested documents | Manual |

### How every orchestration works under the hood

1. **Input validation** — Zod schema validates the payload before any work starts.
2. **Run record created** — a `runs` row is written to Supabase with `status: running`.
3. **Durable execution** — Cloudflare Workflows runs the steps; if the Worker restarts, it resumes from the last checkpoint.
4. **Every step is logged** — before and after each step, a `run_steps` row is written with timing, status, and full LLM prompt/response for observability.
5. **Human-in-the-loop** — `await_approval` steps pause execution until an ops user approves or rejects from the dashboard.
6. **Structured LLM outputs** — all LLM calls use Anthropic tool-use for structured JSON, not free text.

---

## Active Integrations

| Integration | System | Status |
|---|---|---|
| Apollo.io | People search API | Live (requires `APOLLO_API_KEY`) |
| SAM.gov | Federal opportunities API v2 | Live (requires `SAM_GOV_API_KEY`) |
| Jira | Atlassian issue tracking | Live (requires `JIRA_EMAIL` + `JIRA_API_TOKEN`) |
| n8n | Our existing automation platform | Live via webhook (optional secret) |
| Microsoft Teams | Adaptive cards + bot | Live (incoming webhook URL required) |
| GitHub | File/repo access for vault sync | Live (requires `GITHUB_API_TOKEN`) |
| Cloudflare Workers AI | Embeddings for RAG | Live (bound automatically) |
| Accounting (QuickBooks/Unanet) | Invoices, budgets | **Stub — not implemented** |
| CRM (Salesforce/HubSpot) | Contracts | **Stub — not implemented** |
| HR system (BambooHR/ADP) | Employees | **Stub — not implemented** |

---

## What's in the Dashboard

| Page | What it does |
|---|---|
| `/overview` | Live run feed, pending approvals, key stats |
| `/orchestrations` | Browse all orchestrations, trigger runs, toggle active/inactive |
| `/runs` | Full run history with per-orchestration filter |
| `/runs/[id]` | Step-by-step timeline with LLM logs |
| `/schedules` | Create, toggle, and delete cron schedules |
| `/approvals` | Approve or reject paused human-in-the-loop steps |
| `/agents` | Chat with Angie, Beady, Patch, or Money |
| `/documents` | Ingest documents into RAG and query the knowledge base |
| `/analyst` | Direct data analyst interface |
| `/settings` | Platform settings |

---

## What Still Needs to Be Wired Up

The platform runs today but several things must be completed before it is fully operational in production.

### Critical — system will not start without these

| Item | How to set it |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` |
| `SUPABASE_JWT_SECRET` | `wrangler secret put SUPABASE_JWT_SECRET` |
| `ANTHROPIC_API_KEY` | `wrangler secret put ANTHROPIC_API_KEY` |
| `JIRA_EMAIL` | `wrangler secret put JIRA_EMAIL` |
| `JIRA_API_TOKEN` | `wrangler secret put JIRA_API_TOKEN` |
| `SAM_GOV_API_KEY` | `wrangler secret put SAM_GOV_API_KEY` |
| `GITHUB_API_TOKEN` | `wrangler secret put GITHUB_API_TOKEN` |
| GitHub Actions secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NEXT_PUBLIC_*`) | Set in GitHub repo → Settings → Secrets |

### Required for specific features

| Item | Affected feature | How to set |
|---|---|---|
| `APOLLO_API_KEY` | `angie/candidate-sourcing` (currently seeded as inactive) | `wrangler secret put APOLLO_API_KEY` |
| `TEAMS_INCOMING_WEBHOOK_URL` | Teams notifications in patch orchestrations | `wrangler secret put TEAMS_INCOMING_WEBHOOK_URL` |
| `TEAMS_BOT_APP_ID` + `TEAMS_BOT_APP_SECRET` | Two-way Teams bot chat | `wrangler secret put` each |
| `N8N_WEBHOOK_SECRET` | Authenticated n8n webhook calls | `wrangler secret put N8N_WEBHOOK_SECRET` |
| `GITHUB_WEBHOOK_SECRET` | Signed vault-sync webhook | `wrangler secret put GITHUB_WEBHOOK_SECRET` |

### Manual Supabase step

The custom JWT hook (`public.custom_access_token_hook`) was deployed in a migration but must be **manually enabled** in the Supabase dashboard:
> Authentication → Hooks → Custom Access Token → select `public.custom_access_token_hook`

Without this, the `role` claim is read from `app_metadata` as a fallback — which works but requires each user's `app_metadata` to be set correctly.

### Unimplemented integrations (throw at runtime)

These are **stubs** — the code structure exists but the actual API calls are not written yet. The `money/financial-report` orchestration will fail for any accounting-data query until one of these is implemented.

- `integrations/accounting/` — QuickBooks / Unanet / Deltek
- `integrations/crm/` — Salesforce / HubSpot / Deltek Costpoint
- `integrations/hr/` — BambooHR / Workday / ADP

### Security gap to address

The RAG endpoints `/api/documents/query` and `/api/documents/ingest` currently have **no authentication guard**. Anyone with network access to the Worker can read from or write to the knowledge base without a login. These should have `requireOpsToken` added before going to production.
