# Project: Agent Orchestration Layer

You are working on an internal platform that adds an **agent orchestration layer** over existing n8n automations and app integrations. Cloudflare Workers is the runtime, Supabase is the data layer, and a Next.js dashboard is the company-facing surface.

## Read first

Before you do anything substantive, read these in order. They contain decisions you must not relitigate:

1. `docs/architecture.md` — the layer model, why we made each major choice
2. `docs/data-model.md` — Supabase schema (orchestrations, runs, run_steps, tool_calls, artifacts)
3. `docs/workflow-contract.md` — how an orchestration is defined, the `llm_decide` / `llm_extract` primitives, the tool pattern
4. `docs/roadmap.md` — phases and what is in/out of scope right now

If a request would change anything in these documents, stop and surface that to the user before coding.

## Mental model in one paragraph

The orchestration layer is **a deterministic workflow engine with LLM-powered decision points embedded in it** — not an agent loop that happens to call workflows. Each orchestration is a typed workflow (inputs, steps, outputs). Most steps are deterministic (call n8n webhook, query Supabase, hit an integration). A few are `llm_decide(prompt, options)` or `llm_extract(prompt, schema)` with structured outputs. The dashboard's chat surface, if/when we build one, is a separate agent loop that *invokes* orchestrations as tools — it does not reimplement them.

## Stack

- **Runtime:** Cloudflare Workers + Cloudflare Workflows (durable multi-step). Durable Objects only when Workflows doesn't fit.
- **Data:** Supabase (Postgres + RLS + Auth + Realtime). RLS is the auth backbone — do not bypass it with the service role key in code paths the dashboard reaches.
- **Dashboard:** Next.js on Cloudflare Pages, shadcn/ui, Supabase client.
- **LLM:** Anthropic API. Structured outputs via tool use. Always log prompt + response to `run_steps`.
- **Existing system:** n8n flows are wrapped as tools. Do not edit n8n flows from this codebase.

## Repo layout

```
/orchestrations/<name>/
  definition.ts      # workflow definition (typed)
  tools.ts           # tools this workflow uses
  prompts/           # llm_decide / llm_extract prompts
  tests/
/runtime/            # the engine itself: workflow runner, tool registry, LLM primitives
/integrations/       # typed wrappers around n8n webhooks and direct integrations
/db/                 # Supabase migrations, RLS policies, seed data
/dashboard/          # Next.js app
/docs/
.claude/
```

When adding a new orchestration, **clone the closest existing one** in `/orchestrations/` rather than scaffolding from scratch. The pattern is the contract.

## Conventions you must follow

- **TypeScript everywhere.** No `any`. Use `zod` for runtime schemas; derive types from them.
- **Every tool is idempotent or carries an idempotency key.** Workers retry. Assume any tool call may run twice.
- **Every step writes to `run_steps`** before it executes (status: running) and after (status: completed/failed). The runner does this — do not bypass it.
- **No secrets in code.** Wrangler secrets for Workers, Supabase Vault for app-level secrets. If you find a hardcoded credential, stop and tell the user.
- **RLS-first.** When adding a table, write the RLS policy in the same migration. A table without RLS does not get merged.
- **Migrations are forward-only and reviewed.** Never edit an applied migration; add a new one.

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
- The Anthropic SDK in Workers needs the Workers-compatible build — `@anthropic-ai/sdk` works, but watch for Node-only deps.

## What "done" looks like for any change

- Tests pass (unit + integration)
- Lint + typecheck clean
- Migration applied locally and rolled forward in CI
- If runtime or schema changed, a one-paragraph note in the PR describing the migration story for existing runs
- For new orchestrations: a smoke run in the dev environment, with the run linked in the PR description
