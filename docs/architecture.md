# Architecture

## The three layers

```
┌─────────────────────────────────────────────────┐
│  Interface layer                                │
│  Next.js dashboard on Cloudflare Pages          │
│  - Ops surface (admins): runs, logs, retries    │
│  - End-user surface (staff): catalog, forms,    │
│    "my runs", approval inbox                    │
└─────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  Orchestration layer  (NEW — this repo)         │
│  Cloudflare Workers + Workflows                 │
│  - Typed workflow definitions                   │
│  - Tool registry (n8n + direct integrations)    │
│  - llm_decide / llm_extract primitives          │
│  - HTTP / cron / queue triggers                 │
└─────────────────────────────────────────────────┘
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
┌────────────────────┐  ┌──────────────────────┐
│  Execution layer   │  │  Data layer          │
│  - n8n flows       │  │  Supabase (Postgres) │
│  - Direct API      │  │  - runs, run_steps   │
│    integrations    │  │  - tool_calls        │
│                    │  │  - artifacts         │
│                    │  │  - domain tables     │
└────────────────────┘  └──────────────────────┘
```

## Why "deterministic workflows with LLM decision points" instead of "agents"

We considered three models:

1. **LLM-driven agents** (model picks tools each step). Rejected as the default. Hard to debug, expensive, and most of our work is well-structured — n8n flows are already DAGs. Reaching for LLM judgment on every step is overkill.
2. **Pure deterministic orchestration** (state machines only). Rejected as the only model. We have real cases — routing free-text input, exception handling, parameter extraction from messy data — where deterministic code is brittle.
3. **Mix: deterministic spine, LLM at decision points.** Chosen. Each orchestration is a workflow with typed inputs/outputs. Steps are mostly deterministic; some are `llm_decide` or `llm_extract`. The model is invoked surgically where it earns its keep.

This means: when an n8n flow can do the job, it does. When we need judgment, we wrap a narrow LLM call. The result is a system you can reason about at 2am.

## Why Cloudflare Workers + Workflows

- We're already paying for Cloudflare. No new vendor.
- Workers + Workflows give durable multi-step execution out of the box, including retries, sleep-then-resume, and human-in-the-loop pauses. Rolling that ourselves on Durable Objects was the alternative; not worth it.
- Edge runtime makes the dashboard fast globally without effort.
- Workers' cold-start and cost profile beats putting a long-running Node server somewhere.

Tradeoff: Workers' runtime constraints (no Node-only deps, 30s CPU limit per invocation) push some patterns. Workflows handles long-running cases. Direct fetch from Node-only libraries means picking Workers-compatible alternatives.

## Why Supabase as the data layer

- RLS gives us per-user authorization in the database, which is the right place for it given two audiences in one dashboard.
- Auth, Realtime, and Storage are bundled — the dashboard gets login, live run updates, and file artifacts without extra infra.
- Postgres means we keep schema discipline and migrations.

The existing Supabase project's tables are partly n8n-shaped (per-flow tables, ad-hoc execution logs). We will **add** the new orchestration schema alongside those tables. We will **not** migrate n8n's tables. Application code (dashboard, runtime) reads only the new schema. The new schema becomes the source of truth.

## Migration story: n8n today → Workers tomorrow

Phase A (now): Workers wrap n8n. Each n8n flow has a typed wrapper in `/integrations/n8n/<flow>.ts`. Orchestrations call the wrapper. n8n is still doing the actual work.

Phase B (per-flow): When an n8n flow becomes painful (flaky, expensive, hard to evolve), reimplement it as native Worker code. The wrapper's contract doesn't change — only its implementation. Orchestrations don't need to know.

Phase C (eventual): n8n is left handling only the things it's uniquely good at — visual editing for non-devs, niche connectors. Most logic is in Workers.

This means we never do a "big migration." We migrate per-flow, on demand, when ROI is obvious.

## Two audiences, one dashboard

Role-based views over the same data, RLS doing the authorization heavy lifting:

- **Ops users** (devs, admins): runs list, run detail with full timeline, retry/cancel, tool call log, error dashboard.
- **End users** (staff): catalog of orchestrations they can trigger, forms generated from input schemas, "my runs" view, approval inbox for human-in-the-loop steps.

Shared: auth, notifications, search.

The unlock is **schema-driven forms**. Every orchestration declares its input schema in `definition.ts`. The dashboard renders the form from the schema. Adding an orchestration adds a dashboard page automatically. Hand-built per-orchestration UI is a smell unless there's a real reason.

## Open architecture questions

These are not decided. Surface them when relevant:

- Real-time vs. poll for run progress in the dashboard. Probably Supabase Realtime, but we haven't load-tested it.
- Multi-tenancy. Single company today, but if this becomes a product, RLS strategy changes. Worth flagging in any schema change.
- Eval infrastructure for the LLM decision points. Necessary eventually. Not in scope for the first phase.
- Observability stack. Workers Logs + Supabase logs for now. May want OpenTelemetry later.
