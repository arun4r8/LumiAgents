# Architecture

## The layers

```
┌─────────────────────────────────────────────────┐
│  Interface layer                                │
│  Next.js dashboard on Cloudflare Workers        │
│  (via OpenNext)                                 │
│  - Ops surface (admins): runs, logs, retries    │
│  - End-user surface (staff): catalog, forms,    │
│    "my runs", approval inbox                    │
│  - Chat surface: talk to the six agents         │
└─────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  Agent layer                                    │
│  Six named agents (LLM tool-loops)              │
│  - each agent = its own Worker                  │
│    (Service Bindings)                           │
│  - inline runAgentChat = degraded fallback      │
│  - each invokes orchestrations as tools;        │
│    reads knowledge as service_role (see below)  │
└─────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  Orchestration layer  (this repo)               │
│  Cloudflare Workers + Workflows                 │
│  - Typed workflow definitions                   │
│  - Tool registry (direct integrations)          │
│  - llm_decide / llm_extract primitives          │
│  - HTTP / cron / queue triggers                 │
└─────────────────────────────────────────────────┘
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
┌────────────────────┐  ┌──────────────────────┐
│  Execution layer   │  │  Data layer          │
│  - Native Workers  │  │  Supabase (Postgres) │
│  - Direct API      │  │  - runs, run_steps   │
│    integrations    │  │  - tool_calls        │
│                    │  │  - artifacts         │
│                    │  │  - domain tables     │
└────────────────────┘  └──────────────────────┘
```

The recurring shape is **domain table → orchestration → agent tool → dashboard**: business data lands in a domain table, an orchestration acts on it, an agent exposes that orchestration as a tool, and the dashboard renders both the trigger and the result.

## Why "deterministic workflows with LLM decision points" instead of "agents"

We considered three models:

1. **LLM-driven agents** (model picks tools each step). Rejected as the default. Hard to debug, expensive, and most of our work is well-structured and maps cleanly to DAGs. Reaching for LLM judgment on every step is overkill.
2. **Pure deterministic orchestration** (state machines only). Rejected as the only model. We have real cases (routing free-text input, exception handling, parameter extraction from messy data) where deterministic code is brittle.
3. **Mix: deterministic spine, LLM at decision points.** Chosen. Each orchestration is a workflow with typed inputs/outputs. Steps are mostly deterministic; some are `llm_decide` or `llm_extract`. The model is invoked surgically where it earns its keep.

This means: when deterministic code can do the job, it does. When we need judgment, we wrap a narrow LLM call. The result is a system you can reason about at 2am.

## Agents as a thin layer over orchestrations

The orchestrations stay deterministic; the **agent layer** is a conversational skin on top. An agent is an LLM tool-loop whose tools are orchestrations; it does not reimplement workflow logic.

There are two **kinds** of agent, which matters more than the count:

- **Code agents** — defined in `agents/<slug>/index.ts`, deployed as their own Worker. Six today: **Angie** (HR/recruiting), **Beady** (GovCon BD), **Cleo** (eminence/awards/content), **Dewey** (knowledge librarian), **Money** (finance), **Patch** (IT ops/RAG).
- **Config agents** — assembled at runtime from rows in `orchestration.agents` + `orchestration.agent_tools`: a persona, a model, a picked set of existing orchestrations, and a knowledge scope. No code, no Worker, no deploy. Created from the dashboard by the agent builder (#67). Zero exist in production today; the capability shipped ahead of demand.

A config agent is not a lesser agent — it runs the same chat loop over the same orchestrations. What it cannot do is introduce *new* capability: it wires orchestrations that already exist. Creating genuinely new capability still means new code, which is why the agent builder's Tier 2 emits a pull request for a human to review rather than deploying anything itself.

Worker topology is now uniform: **all six agents run as their own Cloudflare Worker**, reached from the runtime over Service Bindings (`runtime/src/routes/agents.ts` maps slug → binding). Isolation is the point: per-agent metrics, logs, CPU budget, and deploys, so one agent's tool surface cannot destabilise another's. The runtime still keeps the inline `runAgentChat` loop, but only as a **degraded fallback**: if an agent's Worker is unreachable or returns an error, the runtime runs the chat loop itself rather than failing the user's request. That fallback is what makes standing up a new agent Worker safe, since a Worker deployed before its secrets are set simply degrades instead of breaking chat.

**Knowledge access is enforced in the runtime, not the database.** Every agent executes as Postgres `service_role` and bypasses RLS, so we cannot lean on Postgres roles to scope retrieval. Instead `runtime/src/agents/knowledge-access.ts` defines the scope: each agent may read the `shared` corpus plus a private corpus keyed by its own slug, and never sees `restricted`-sensitivity documents (ops-only). `orchestration.match_document_chunks` takes `allowed_corpora` / `include_restricted` and filters accordingly. Dewey is the librarian that searches, re-tags, and inventories that corpus.

Retrieval is scoped to the **caller**, not to the orchestration's author (#177). A retrieval orchestration used to hardcode `scopeForAgent("<its own slug>")`, so a config agent that wired `dewey/knowledge-search` inherited dewey's private corpus regardless of what it declared. The caller's identity now travels as an `agent_slug` claim on the internally-minted dispatch token — minted by the runtime, unforgeable by the agent Worker, which does not hold the JWT secret — and the route derives the scope server-side from the catalog row. The caller asserts identity; the server decides authority. The mechanism is narrowing-only: an absent or unresolvable slug falls back to the orchestration's own scope, never a wider one.

## Why Cloudflare Workers + Workflows

- We're already paying for Cloudflare. No new vendor.
- Workers + Workflows give durable multi-step execution out of the box, including retries, sleep-then-resume, and human-in-the-loop pauses. Rolling that ourselves on Durable Objects was the alternative; not worth it.
- Running the dashboard on Cloudflare Workers (via OpenNext) keeps it fast globally without effort.
- Workers' cold-start and cost profile beats putting a long-running Node server somewhere.

Tradeoff: Workers' runtime constraints (no Node-only deps, 30s CPU limit per invocation) push some patterns. Workflows handles long-running cases. Direct fetch from Node-only libraries means picking Workers-compatible alternatives.

## Why Supabase as the data layer

- RLS gives us per-user authorization in the database, which is the right place for it given two audiences in one dashboard.
- Auth, Realtime, and Storage are bundled, so the dashboard gets login, live run updates, and file artifacts without extra infra.
- Postgres means we keep schema discipline and migrations.

The existing Supabase project's tables are partly n8n-shaped (per-flow tables, ad-hoc execution logs). We will **add** the new orchestration schema alongside those tables. We will **not** migrate n8n's tables. Application code (dashboard, runtime) reads only the new schema. The new schema becomes the source of truth.

## Migration story: n8n to Workers (complete)

The migration is done. Nothing runs in n8n in production, the `/integrations/n8n/` directory no longer exists, and every orchestration executes as native Worker code. GovCon scoring, resume scoring, and resume formatting were the last flows reimplemented in-Worker (see the `*_native_*` migrations).

We never did a "big migration." Each flow was reimplemented on demand behind a stable orchestration contract, so callers never had to change as the underlying execution moved from n8n to native Workers.

n8n interop is now dormant-but-retained: the `drainN8nCallQueue` function drains the `n8n_call_queue` table, gated behind `N8N_QUEUE_ENABLED` (disabled by default), with `N8N_WEBHOOK_SECRET` kept for header auth. This lets a niche flow be re-enabled without a code change, but nothing uses it in production.

## Two environments, one manual gate

There are two complete stacks — **production** and **staging** — each with its own Supabase project, its own runtime Worker, its own six agent Workers, and its own dashboard (#121).

A merge to `main` deploys **staging** automatically. Production is a separate, manually dispatched promotion. The gate lives in the deploy pipeline rather than in GitHub branch protection, so the thing being promoted is a build that has already run somewhere real.

Two properties are deliberate and easy to mistake for bugs:

- **Staging holds no business data.** It is a schema twin, not a data twin. Auditing staging by clicking through it will show empty states and tell you nothing; compare code, not screens.
- **Staging is deliberately missing most secrets.** Several integrations write to the real world and have no staging counterpart — the Knowledge Base editor commits to the production vault, the content calendar writes the real SharePoint workbook, Resend sends real email to real people, Jira creates real tickets. Those features fail closed in staging, and that broken tab is the safety mechanism working. `docs/environments.md` is authoritative on which secrets are withheld and why; do not "fix" one without reading it.

## Two execution paths, and the rule that separates them

An orchestration runs one of two ways:

- **Durable** (`POST /api/orchestrations/:name/run`) — a Cloudflare Workflow instance. Checkpointed steps, retries, sleep-then-resume, and `await_approval` pauses. This is the default and the only path that may mutate anything.
- **Inline** (`POST /api/orchestrations/:name/run-sync`) — executed in-process so the caller gets a real answer back instead of a run id. This is what makes an agent's question-answering tools feel like answers rather than tickets.

The inline path has no durable execution and may retry a step in-process, which is harmless for a read and unsafe for a mutation. That rule used to exist only as a comment. It is now enforced at the route (#127): `/run-sync` is ops-only, and refuses any orchestration that does not declare `readOnly: true`. Endusers reach orchestrations through the durable path, which honours approvals and checkpointing.

## Two audiences, one dashboard

Role-based views over the same data, RLS doing the authorization heavy lifting:

- **Ops users** (devs, admins): runs list, run detail with full timeline, retry/cancel, tool call log, error dashboard.
- **End users** (staff): catalog of orchestrations they can trigger, forms generated from input schemas, "my runs" view, approval inbox for human-in-the-loop steps.

Shared: auth, notifications, search.

Notifications run on a single unified `subscriptions` table (a `kind` discriminator separates opportunity vs. award digests, replacing the older per-domain subscription tables). Scheduled digests and **operational failure alerts go to subscribers by email via Resend**. Email is the only outbound notification channel: both Microsoft Teams surfaces (the bot and the Office 365 Connector webhook) were retired, and agent chat lives in the dashboard.

On top of the per-orchestration health checks, the runtime alerts on **every** run that transitions to `failed`, from one place (`runtime/src/utils/run-failure-alert.ts`, called by `workflow.ts` and the cron dispatcher). A new orchestration is covered without its author doing anything. Suppression state lives in `orchestration.run_failure_alerts`: one email on the first failure of a streak, one when the error changes, one reminder per 6h while it stays broken, and one when it recovers. Alerting is fail-open, so it can never break a run.

The unlock is **schema-driven forms**. Every orchestration declares its input schema in `definition.ts`. The dashboard renders the form from the schema. Adding an orchestration adds a dashboard page automatically. Hand-built per-orchestration UI is a smell unless there's a real reason.

## Open architecture questions

These are not decided. Surface them when relevant:

- ~~Real-time vs. poll for run progress in the dashboard.~~ **Decided: polling** (#142). `supabase_realtime` publishes zero tables and no migration ever added one, so a subscription connected and then never fired — a screen that looked alive and was frozen. The dashboard now polls openly and says so, and `runtime/../use-run-live.ts` stops the moment a run reaches a terminal status. One conditional poll per in-flight card beats N websockets at this scale. Revisit only if a genuine live stream is wanted, which is scoped work, not a toggle.
- Multi-tenancy. Single company today, but if this becomes a product, RLS strategy changes. Worth flagging in any schema change.
- Eval infrastructure for the LLM decision points. Necessary eventually. Not in scope for the first phase.
- Observability stack. Workers Logs + Supabase logs for now. May want OpenTelemetry later.
