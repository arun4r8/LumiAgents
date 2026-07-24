# LumiAgents Platform Overview

_Prepared for leadership review, updated July 2026_

---

## What we built

LumiAgents is an **agent orchestration platform**. The n8n automations it started from have been migrated in; today every AI-powered business process is a **typed, auditable, resumable workflow** with LLM decision points embedded in it, executed directly on Cloudflare Workers.

The platform has four layers:

| Layer | Technology | Purpose |
|---|---|---|
| **Runtime** | Cloudflare Workers + Cloudflare Workflows | Executes orchestrations durably; retries, survives crashes |
| **Data** | Supabase (Postgres + RLS + Realtime) | Stores every run, step, LLM call, and artifact; enforces access control |
| **Dashboard** | Next.js on Cloudflare Workers (via OpenNext) | Ops team interface: trigger runs, monitor, approve, subscribe, configure |
| **Agents** | Anthropic Claude (`claude-sonnet-4-6`; `claude-haiku-4-5` for cheap OCR/scoring) | Six named agents that wrap orchestrations as tools for conversational use |

### The core pattern

Every capability follows the same spine: a **domain table** holds the data → an **orchestration** does the work (validate → run steps → log) → an **agent tool** wraps that orchestration for chat → the **dashboard** surfaces it as a page. New capabilities are added by walking that spine, not by bolting on one-off scripts.

---

## Deployment & GitHub Integration

### How code ships

Two GitHub Actions workflows live in `.github/workflows/`:

**`deploy-worker.yml`** fires on any push to `main` that touches `runtime/`, `orchestrations/`, or `integrations/`.
Steps: install → typecheck → `wrangler deploy` → runtime is live on Cloudflare Workers.

**`deploy-dashboard.yml`** fires on any push to `main` that touches `dashboard/`.
Steps: install → `opennextjs-cloudflare build` → `opennextjs-cloudflare deploy` → dashboard is live on Cloudflare Workers (via OpenNext).

Both workflows are **fully automatic**: merging to `main` is the deployment mechanism. No manual steps.

### Environments

- **Production:** default Cloudflare environment, `wrangler.toml` root config.
- **Development:** `[env.dev]` block in `wrangler.toml`; deploy with `wrangler deploy --env dev`.
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

## The Six Agents

Each agent is a named AI persona with a system prompt and a set of tools that map directly to orchestrations. When you chat with an agent, it decides which orchestrations to invoke based on your request.

**Worker topology:** all six agents each run as their own Cloudflare Worker (reached via Service Bindings), mapped by slug in `AGENT_BINDINGS` in `runtime/src/routes/agents.ts`. If an agent's Worker is unreachable or errors, the runtime degrades to running that agent's chat loop inline rather than failing the request.

### Angie: HR & Recruiting
Sourcing and resume work.
- `source_candidates` → `angie/candidate-sourcing` (Apollo search → LLM scoring → approval gate)
- `score_resumes` → `angie/resume-scoring`
- `format_resume` → `angie/resume-format`

### Beady: GovCon Business Development
Discovery, scoring, **and** response drafting (RFI drafting moved here from Cleo).
- `search_all_opportunities` → parallel SAM.gov + SBIR sweep
- `search_opportunities` → `beady/opportunity-search` (SAM.gov → LLM scoring → upsert)
- `search_sbir_topics` → `beady/sbir-topic-search`
- `assess_opportunity` → `beady/govcon-assessment` (5-dimension go/no-go)
- `seed_past_performance` → `beady/past-performance-seed` (embeds records into RAG)
- `draft_rfi` → `beady/rfi-draft` (Sources Sought / RFI drafting)
- `find_industry_days` → `beady/industry-day-sweep`

### Cleo: Eminence, Awards & Content
Award tracking plus the content/eminence calendar.
- `sweep_awards` → `cleo/award-sweep`
- `send_award_digest` → `cleo/award-report`
- `plan_calendar` → `cleo/content-plan`
- `draft_content` → `cleo/content-draft`

### Dewey: Knowledge Librarian
Steward of the shared knowledge corpus.
- `search_knowledge` → `dewey/knowledge-search`
- `retag_document` → `dewey/retag-document` (set a document's corpus / sensitivity)
- `knowledge_inventory` → `dewey/knowledge-inventory`

### Money: Finance & Data Analytics
- `query_data` → `money/data-analyst` (NL → SQL → execute → interpret)
- `generate_financial_report` → `money/financial-report` (multi-question analysis → executive report)

### Patch: IT Operations & Knowledge
- `create_ticket` / `update_ticket` / `search_tickets` → `patch/ticket-ops` (Jira CRUD)
- `staff_request` → `patch/staff-request`
- `query_documents` → `patch/document-rag` (RAG search across ingested knowledge)

**Access:** every agent has a chat page under `/agents/<slug>`.

---

## Orchestrations & Scheduling

All orchestrations are managed from the dashboard at `/orchestrations`. Each can be triggered manually, via agent chat, or on a cron schedule. They are registered in `runtime/src/registry.ts`.

**Meta-cron scheduling:** a single Cloudflare cron (`*/5 * * * *`) reads the `orchestration.schedules` table and dispatches any row whose cron expression matches the current minute, guarded by `last_run_at` so a row fires once per window. Adding a scheduled job is a row, not a code change.

Notable scheduled jobs:

| Orchestration | Domain | Schedule |
|---|---|---|
| `beady/opportunity-sweep` | GovCon BD | Daily (parallel SAM.gov + SBIR) |
| `beady/opportunity-report` | GovCon BD | Daily digest, 13:00 UTC |
| `beady/industry-day-sweep` | GovCon BD | Weekly, Mon 10:00 UTC |
| `cleo/award-sweep` | Eminence | Weekly |
| `cleo/award-report` | Eminence | Daily digest, 14:00 UTC |
| `cleo/content-nudge` | Eminence | Daily, 09:00 UTC |
| `system/memory-maintenance` | Platform | Daily |

Manual/event orchestrations include `angie/candidate-sourcing`, `angie/resume-scoring`, `angie/resume-format`, `beady/opportunity-search`, `beady/sbir-topic-search`, `beady/govcon-assessment`, `beady/past-performance-seed`, `beady/rfi-draft`, `cleo/content-plan`, `cleo/content-draft`, `dewey/*`, `money/data-analyst`, `money/financial-report`, and `patch/*` (document-rag ingest+query, inbound-triage, staff-request, ticket-ops).

### How every orchestration works under the hood

1. **Input validation:** Zod schema validates the payload before any work starts.
2. **Run record created:** a `runs` row is written to Supabase with `status: running`.
3. **Durable execution:** Cloudflare Workflows runs the steps; if the Worker restarts, it resumes from the last checkpoint.
4. **Every step is logged:** before/after each step a `run_steps` row records timing, status, and the full LLM prompt/response.
5. **Human-in-the-loop:** `await_approval` steps pause execution until an ops user approves or rejects from the dashboard.
6. **Structured LLM outputs:** all LLM calls use Anthropic tool-use for structured JSON, not free text.

---

## Knowledge Corpus & Sensitivity Model

The shared knowledge base powers RAG for every agent, but not every agent may read everything. Because agents execute as Postgres `service_role` (they bypass RLS), the read rules are enforced in the **runtime retrieval path**, not by database roles. Each document chunk carries two tags:

- **`corpus`**: `shared` (readable by every agent) or an agent slug (private to that agent). Default `shared`.
- **`sensitivity`**: `internal` (team-usable, default) or `restricted` (ops-only; never returned to an agent).

`orchestration.match_document_chunks(...)` filters retrieval on both, driven by `runtime/src/agents/knowledge-access.ts`: `scopeForAgent(slug)` yields `{allowedCorpora: [shared, slug], includeRestricted: false}`, while `OPS_SCOPE` sees everything including restricted. **Dewey** is the librarian who searches the shared corpus, re-tags a document's corpus/sensitivity, and inventories the base.

Embeddings are Cloudflare Workers AI `@cf/baai/bge-large-en-v1.5` (1024-dim), stored in pgvector (ivfflat, cosine); the same model backs **agent memory** (per-conversation message history embedded for recall), maintained by the daily `system/memory-maintenance` job.

---

## Subscriptions, Digests & Alerts

**Unified subscriptions.** A single `orchestration.subscriptions` table with a `kind` discriminator (`opportunity` | `award`) drives all digests; it holds the superset of filter columns (sources / agencies / set-asides for opportunity; award types for award). It replaces the old `report_subscriptions` + `award_subscriptions` tables, which still exist but are deprecated (kept only as a rollback net; all readers use `subscriptions`).

**One surface.** All digests are created, edited, paused, deleted and sent from `/subscriptions` (All / Opportunity / Award tabs). Award digests are additionally editable in context at the bottom of `/awards`. The former `/reports` page rendered the same client component pre-filtered to `kind = 'opportunity'`, so it was folded into `/subscriptions` and now redirects there.

**Digests.** Each agent's digest is its own scheduled orchestration (`beady/opportunity-report`, `cleo/award-report`), driven by the meta-cron, honoring each subscription's cadence (daily/weekly) and sending via the shared Resend `sendEmail` with a per-agent `from`. A dashboard "Send now" hits `/api/orchestrations/{name}/run` with `{subscriptionId}`, routed by kind.

**Email alerts to subscribers.** Operational failure/health alerts go by **email to the live recipients of the active subscriptions** (Teams is no longer used for alerts). Beady's sweep-health alert emails opportunity subscribers when SAM fails; Cleo's content-nudge emails subscribers when posts are due. `ALERT_EMAIL` adds fixed recipients. The sweep alert deliberately stays quiet about the known SBIR outage so it doesn't spam.

---

## Content Calendar

`content_calendar` drives Cleo's LinkedIn / eminence drafting. Populate it three ways: manual add, `plan_calendar` (theme → idea rows), or **CSV import** (`dashboard/lib/content-csv.ts` parses a spreadsheet export; a `source_key` makes re-import idempotent and preserves existing drafts). `draft_content` writes post copy + an asset brief grounded **only** in the company profile; a human approves and there is **no auto-publish**. A live Microsoft Graph sync was deliberately deferred (CSV export was chosen); Graph is the future upgrade path.

---

## Industry Days

`beady/industry-day-sweep` gathers agency industry days from two sources: SAM.gov **Special Notices** (`ptype=s`) and a Tavily web sweep. It LLM-scores each for relevance to Lumiture and upserts into `industry_days` (with an `industry_day_scored` dedup ledger). Runs weekly; surfaced on the `/industry-days` dashboard page and via the `find_industry_days` tool.

---

## Auth

Two enforced roles: **ops** (full access) and **enduser** (own records only), enforced both in Postgres RLS (`auth.jwt()->>'role'`) and in runtime route guards (`requireOpsToken`). Agents have no DB identity; all run as `service_role`. (`role:analyst` and `role:hr` appear in orchestration `access` metadata but are not enforced anywhere.) Login is email + password via Supabase. Currently 4 ops accounts; no enduser accounts yet.

The custom JWT hook (`public.custom_access_token_hook`) is deployed by migration but must be **manually enabled** in the Supabase dashboard (Authentication → Hooks → Custom Access Token). Without it, the `role` claim falls back to `app_metadata`.

---

## What's in the Dashboard

| Page | What it does |
|---|---|
| `/overview` | Live run feed, pending approvals, key stats |
| `/orchestrations` | Browse all orchestrations, trigger runs, toggle active/inactive |
| `/runs` and `/runs/[id]` | Run history and step-by-step timeline with LLM logs |
| `/schedules` | Create, toggle, and delete cron schedules |
| `/approvals` | Approve or reject paused human-in-the-loop steps |
| `/agents/<slug>` | Chat with Angie, Beady, Cleo, Dewey, Money, or Patch |
| `/subscriptions` | Unified digest subscriptions (All / Opportunity / Award tabs). `/reports` redirects here, preselecting the Opportunity tab |
| `/awards` | Award tracker with an embedded award-subscription section |
| `/industry-days` | Discovered agency industry days |
| `/documents` | Ingest documents into RAG and query the knowledge base |
| `/analyst` | Direct data-analyst interface |
| `/settings` | Platform settings |

---

## Known Gaps

- **Accounting / CRM / HR integrations are stubs:** `integrations/accounting`, `integrations/crm`, `integrations/hr` throw at runtime; `money/financial-report` fails on any accounting-data query until one is implemented.
- **SBIR source is externally unavailable:** the DoD topics portal now sits behind Akamai bot-protection and the SBIR.gov API is disabled; the integration code is correct but upstream is down.
- **SAM.gov key rotation:** `SAM_GOV_API_KEY` expires roughly every 90 days and must be renewed to keep the Beady sweeps and RFI attachment fetch working.
