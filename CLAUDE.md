# Project: Agent Orchestration Layer

You are working on an internal platform that adds an **agent orchestration layer** over existing n8n automations and app integrations. Cloudflare Workers is the runtime, Supabase is the data layer, and a Next.js dashboard is the company-facing surface.

## Read first

Before you do anything substantive, read these in order. They contain decisions you must not relitigate:

1. `docs/architecture.md`: the layer model, why we made each major choice
2. `docs/data-model.md`: Supabase schema (orchestrations, runs, run_steps, tool_calls, artifacts)
3. `docs/workflow-contract.md`: how an orchestration is defined, the `llm_decide` / `llm_extract` primitives, the tool pattern
4. `docs/roadmap.md`: phases and what is in/out of scope right now

If a request would change anything in these documents, stop and surface that to the user before coding.

## Mental model in one paragraph

The orchestration layer is **a deterministic workflow engine with LLM-powered decision points embedded in it**, not an agent loop that happens to call workflows. Each orchestration is a typed workflow (inputs, steps, outputs). Most steps are deterministic (call n8n webhook, query Supabase, hit an integration). A few are `llm_decide(prompt, options)` or `llm_extract(prompt, schema)` with structured outputs. The dashboard's chat surface is built as six named agents: each is a separate agent loop that *invokes* orchestrations as tools; it does not reimplement them. The core pattern is **domain table → orchestration → agent tool → dashboard**.

## Agents (six)

Six named agents, each an LLM tool-loop that calls orchestrations. Defined in `/agents/<slug>/`:

- **Angie**: HR & recruiting
- **Beady**: GovCon business development (discovery, scoring, RFI/Sources-Sought drafting, industry days)
- **Cleo**: eminence, awards & proposals, content calendar
- **Dewey**: knowledge librarian; steward of the shared knowledge corpus
- **Money**: finance & analytics
- **Patch**: IT ops & knowledge/RAG

**Worker topology:** all six agents run as their own Cloudflare Worker (reached via Service Bindings from the runtime), one entry in `AGENT_BINDINGS` in `runtime/src/routes/agents.ts` each. The runtime keeps an inline `runAgentChat` path as a degraded fallback: if an agent's Worker is unreachable or returns an error (for example a freshly created Worker whose secrets are not set yet), chat runs inside `lumiagents-runtime` instead of failing.

**Knowledge access:** all agents execute as Postgres `service_role` and bypass RLS, so *which agent may read which knowledge* is enforced in the runtime retrieval path (`runtime/src/agents/knowledge-access.ts`), not by Postgres roles. Each agent reads the `shared` corpus plus its own private corpus (by slug); `restricted`-sensitivity documents are ops-only and never returned to an agent. Dewey is the librarian.

## Stack

- **Runtime:** Cloudflare Workers + Cloudflare Workflows (durable multi-step). Durable Objects only when Workflows doesn't fit.
- **Data:** Supabase (Postgres + RLS + Auth + Realtime). RLS is the auth backbone; do not bypass it with the service role key in code paths the dashboard reaches.
- **Dashboard:** Next.js on Cloudflare Pages, shadcn/ui, Supabase client.
- **LLM:** Anthropic API. Structured outputs via tool use. Always log prompt + response to `run_steps`.
- **Existing system:** n8n flows are wrapped as tools. Do not edit n8n flows from this codebase.

## Repo layout

```
/orchestrations/<agent>/<name>/
  definition.ts      # workflow definition (typed)
  tools.ts           # tools this workflow uses
/agents/<slug>/      # the six agents (LLM tool-loops that invoke orchestrations)
/runtime/            # the engine itself: workflow runner, tool registry, LLM primitives
/integrations/       # typed wrappers around external integrations (SAM.gov, SBIR, Tavily, Resend, Jira, Apollo, MS Graph, ...)
/supabase/           # migrations, RLS policies, seed data
/dashboard/          # Next.js app
/docs/
.claude/
```

When adding a new orchestration, **clone the closest existing one** in `/orchestrations/` rather than scaffolding from scratch. The pattern is the contract.

## Conventions you must follow

- **TypeScript everywhere.** No `any`. Use `zod` for runtime schemas; derive types from them.
- **Every tool is idempotent or carries an idempotency key.** Workers retry. Assume any tool call may run twice.
- **Every step writes to `run_steps`** before it executes (status: running) and after (status: completed/failed). The runner does this; do not bypass it.
- **No secrets in code.** Wrangler secrets for Workers, Supabase Vault for app-level secrets. If you find a hardcoded credential, stop and tell the user.
- **RLS-first.** When adding a table, write the RLS policy in the same migration. A table without RLS does not get merged.
- **Migrations are forward-only and reviewed.** Never edit an applied migration; add a new one.
- **Migrations are not replayable from scratch on their own.** The chain assumes a pre-existing n8n-era schema that was never captured in a migration, so an empty Supabase project needs `supabase/bootstrap-fresh-project.sql` run *before* the first `supabase db push` (it is not a migration — never put it in `supabase/migrations/`). Don't deepen that assumption: guard anything touching a legacy object with `IF EXISTS` / `IF NOT EXISTS`, use `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`, and never rely on `ADD COLUMN IF NOT EXISTS … CHECK (…)` to create a constraint (the CHECK is silently skipped when the column already exists). If a new migration needs a legacy table's shape, add that shape to the bootstrap script in the same PR. See `docs/environments.md` → "Rebuilding the database from scratch".

## Conventions you should follow unless there's reason not to

- One orchestration per PR. Schema changes in their own PR.
- Prefer Cloudflare Workflows over hand-rolled Durable Object state machines.
- Prefer typed integration wrappers over calling fetch from a workflow directly.
- Generate dashboard forms from the orchestration's input schema. Hand-built forms are a smell.

## How to work in this repo

- Use **plan mode** (Shift+Tab) for: schema changes, runtime/engine changes, anything touching auth or RLS, anything spanning more than 3 files.
- For research-heavy questions ("how does X work in our codebase", "find every caller of Y"), **delegate to a subagent** so you don't fill main context with file reads. See `.claude/agents/`.
- For repeated playbooks (adding an orchestration, adding an integration, writing a migration), use the matching skill in `.claude/skills/`.
- For repeated commands (run tests, deploy a Worker, apply migrations), use slash commands in `.claude/commands/`.

## Gotchas

- Workers have a 30s CPU limit per invocation. Long-running orchestrations belong in Workflows, not raw Workers.
- Supabase RLS does not apply when using the service role key. The runtime uses service role; the dashboard does not. Don't blur this line.
- n8n webhooks are not idempotent by default. Wrap them with an idempotency key in `/integrations/n8n/`.
- The Anthropic SDK in Workers needs the Workers-compatible build: `@anthropic-ai/sdk` works, but watch for Node-only deps.

## What "done" looks like for any change

- Tests pass (unit + integration)
- Lint + typecheck clean
- Migration applied locally and rolled forward in CI
- If runtime or schema changed, a one-paragraph note in the PR describing the migration story for existing runs
- For new orchestrations: a smoke run in the dev environment, with the run linked in the PR description
