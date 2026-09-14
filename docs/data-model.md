# Data model

The orchestration layer's tables live in the `orchestration` schema in Supabase. n8n's existing tables stay in `public` (or wherever they are now) and are not touched by this codebase.

## Schema overview

```
orchestrations            -- definitions, versioned
  id, name, version, input_schema (jsonb), output_schema (jsonb),
  is_active, created_at, definition_hash

runs                      -- one per invocation
  id, orchestration_id, orchestration_version,
  status (pending|running|paused|completed|failed|cancelled),
  input (jsonb), output (jsonb), error (jsonb),
  triggered_by (user_id | 'cron' | 'webhook' | 'orchestration'),
  triggered_by_run_id,    -- for child runs
  started_at, ended_at, created_at

run_steps                 -- per-step log
  id, run_id, step_index, step_name, step_type,
  status, input (jsonb), output (jsonb), error (jsonb),
  llm_model, llm_input_tokens, llm_output_tokens,
  started_at, ended_at

tool_calls                -- per call to n8n / integrations
  id, run_step_id, tool_name, idempotency_key,
  request (jsonb), response (jsonb), status_code,
  latency_ms, started_at, ended_at

artifacts                 -- files/blobs produced by runs
  id, run_id, run_step_id, kind, mime_type,
  storage_path, size_bytes, created_at

approvals                 -- human-in-the-loop pause records
  id, run_id, run_step_id, requested_from (user_id | role),
  prompt, status (pending|approved|rejected|expired),
  decided_by, decided_at, decision_notes,
  expires_at, created_at
```

Two more engine tables round out the `orchestration` schema:

```
schedules                 -- meta-cron dispatch table
  id, orchestration_name, label, cron_expression,
  is_active, default_input (jsonb), last_run_at, created_at, updated_at

orchestration_access      -- end-user allow-list join table
  (orchestration ↔ user grants; see RLS below)

agent_configs             -- per-agent LLM model config
  (resolved at run start into RunContext.model; per-orchestration override)
```

A meta-cron (`*/5 * * * *`) reads `schedules` and dispatches any row whose `cron_expression` is due, guarded by `last_run_at`. This is how the daily/weekly sweeps, digests, and nudges fire.

## Domain tables

Domain tables (the actual business data the orchestrations operate on) live in their own schemas, separate from this telemetry; don't conflate them. Most sit in `public` (ops dashboard reads them via RLS, gated by `public.is_ops()`); a few internal ledgers and all knowledge/memory tables sit in `orchestration`. Schema is called out per table.

### GovCon (Beady)

- `opportunities` (`public`): the saved shortlist of SAM.gov + SBIR notices (fit ≥ min score). Key: `sam_notice_id` (raw SAM `noticeId`, or `sbir_<topicNumber>` for SBIR/STTR topics).
- `orchestration.scored_notices`: dedup ledger of **every** notice the sweep has scored (pass or pursue), so nothing is ever re-scored (re-billed to the LLM). Columns: `notice_id` (PK, matches `opportunities.sam_notice_id`), `source`, `fit_score`, `recommendation`, `scored_at`.
- `govcon_assessments`: **DROPPED** (migration `20260512000001`). Go/no-go assessments now live in `public.assessments`; this table no longer exists.
- `rfi_drafts` (`public`): Beady's Sources Sought / RFI response drafts (moved here from Cleo). Columns: `id`, `sam_notice_id`, `opportunity_title`, `agency`, `notice_type`, `response_deadline`, `draft_markdown` (nullable; empty while a row waits at the intake gate), `model`, `created_at`, plus the hybrid-workflow columns (migration `20260721000001`): `status` (`intake`|`drafting`|`ready`, default `ready`), `analysis` (jsonb: required-content list, risk flags, sufficiency verdict), `intake` (jsonb: questions/gaps/fit matrix surfaced when gated), `answers` (jsonb: the user's answers fed back into drafting), and `assessment` (jsonb: compliance / evaluation-factor / accuracy review of the draft). Grounded in company profile + past performance.
- `industry_days` (`public`): government vendor-outreach events discovered from SAM.gov Special Notices (`ptype=s`) + a Tavily web sweep, scored for fit. Columns: `id`, `event_id` (UNIQUE: SAM notice id or `fnv1a(source_url)`), `title`, `agency`, `event_date`, `location`, `format`, `registration_url`, `source` (`sam_gov`|`web`), `source_url`, `description`, `fit_score` (1–10), `fit_reason`, `recommendation` (`attend`|`consider`|`skip`), `last_scored_at`, `created_at`.
- `industry_day_scored` (`public`), the dedup ledger for the industry-day sweep: `event_id` (PK), `content_hash`, `scored_at`.

### Awards & eminence (Cleo)

- `awards` (`public`): industry recognition + government small-business award programs from the weekly Tavily sweep. Columns include `award_id` (UNIQUE), `title`, `sponsor`, `category`, `award_type` (`industry`|`government`), `application_deadline`, `nomination_deadline`, `source_url`, `fit_score` (1–10), `fit_reason`, `prestige`, `effort`, `recommendation` (`apply`|`consider`|`skip`), `last_scored_at`.
- `orchestration.award_scored`, the dedup ledger: `award_id` (PK), `content_hash`, `scored_at`.
- `content_calendar` (`public`): the eminence plan (LinkedIn posts, etc.) as data. Columns: `id`, `release_date`, `topic` (NOT NULL), `channel` (default `linkedin`), `asset_type`, `asset_ref`, `description`, `draft_markdown` (Cleo's drafted copy + asset brief), `status` (`idea`|`drafting`|`ready`|`scheduled`|`posted`), `owner`, `model`, timestamps, plus `source_key`, a nullable text column with a partial unique index (`WHERE source_key IS NOT NULL`) that makes CSV re-import idempotent (re-uploading an edited sheet updates the same rows instead of duplicating; manual rows leave it NULL). Humans always approve/post; there is no auto-publish.

### Subscriptions / digests (unified)

- `orchestration.subscriptions`: the **unified** digest table with a `kind` discriminator (`'opportunity'` | `'award'`). Superset shape: common columns (`id`, `user_id`, `label`, `kind`, `cadence` (`daily`|`weekly`), `recipients` (NOT NULL), `min_fit_score` (default 6), `is_active`, `last_sent_at`, timestamps) plus kind-specific filter columns that coexist: opportunity uses `sources` / `agencies` / `set_asides`; award uses `award_types`. Each agent's digest orchestration reads its `kind` and honors per-subscription cadence.
- `orchestration.report_subscriptions` and `orchestration.award_subscriptions` are **DEPRECATED** legacy tables. Both still exist as a rollback net (`subscriptions` backfilled from them, preserving ids), but all readers now use the unified table. To be dropped in a later migration once the unified path is proven.

### Knowledge / RAG

- `orchestration.orch_documents` + `orchestration.document_chunks`: the shared knowledge corpus (Workers AI `bge-large-en-v1.5`, 1024-dim, ivfflat cosine). `orch_documents` now carries two access-control columns. `corpus` (NOT NULL, default `'shared'`) is either `shared` (every agent reads it) or an agent slug for that agent's private corpus. `sensitivity` (NOT NULL, default `'internal'`, CHECK `internal|restricted`) gates visibility: `restricted` never surfaces in agent retrieval unless explicitly requested.
- Retrieval RPC: `orchestration.match_document_chunks(query_embedding extensions.vector(1024), match_count integer DEFAULT 6, min_similarity float DEFAULT 0.5, allowed_corpora text[] DEFAULT NULL, include_restricted boolean DEFAULT false)`. `allowed_corpora = NULL` means no corpus restriction (ops/dashboard); otherwise it filters `corpus = ANY(allowed_corpora)`. `include_restricted = false` excludes `sensitivity='restricted'`. The RPC returns `corpus` and `sensitivity` alongside each chunk. Because agents all run as `service_role` and bypass RLS, this RPC, not Postgres roles, is where per-agent knowledge access is enforced (each agent passes the corpora it is allowed to read). Note the `vector` type is schema-qualified to `extensions`.

### Agent memory

All in `orchestration`:

- `conversations`: one per (agent, user) thread; `agent_slug`, `user_id`, `title`, timestamps, `last_message_at`.
- `messages`: transcript rows (`conversation_id` FK, `role` (`user`|`assistant`), `content`).
- `memory_chunks`: semantic recall (`user_id`, `agent_slug`, `conversation_id`, `source_message_id`, `kind` (`turn`|`summary`|`fact`), `content`, `embedding vector(1024)`). Recalled via `orchestration.match_memory(query_embedding, p_user_id, p_agent_slug, …)`, scoped to one (user, agent) inside the SECURITY DEFINER function.

### Misc

`agent_tasks`, `analyst_uploads`, `api_budget`, `rate_limit` (per-user fixed-window limiter via the `claim_rate_limit` RPC), and the `n8n_call_queue`.

`run_failure_alerts` is the anti-spam ledger behind run-level failure alerting: one row per *currently failing* orchestration (`orchestration_name` PK, `error_fingerprint`, `last_error`, `consecutive_failures`, `last_failed_run_id`, `first_failed_at`, `last_failed_at`, `last_alerted_at`). The runtime writes it on every failed run and deletes the row on the next success. Not telemetry, so don't read it for history; `runs` is the record.

## Why this shape

- **`runs` and `run_steps` separated:** lets you query "all failed steps of type llm_decide last week" without scanning run JSON blobs.
- **`tool_calls` separate from `run_steps`:** a single step may make several tool calls (e.g., a retry). Keeping them flat makes audit and cost analysis tractable.
- **Orchestrations are versioned:** a run records the version it executed against. Changing an orchestration definition does not retroactively change history.
- **`approvals` as first-class:** human-in-the-loop is a known case, not an afterthought. The runtime pauses the workflow and creates an approval row; the dashboard renders it; resolution resumes the workflow.

## RLS (read these policies before writing new ones)

Two roles matter at the database level: `ops` and `enduser`. The dashboard's Supabase client authenticates as the user; their JWT carries their role(s).

- `orchestrations`: ops can read/write all. End users can read rows where `is_active = true` AND they are in the orchestration's allow-list (stored in a join table `orchestration_access`).
- `runs`: ops can read/write all. End users can read runs where `triggered_by = auth.uid()` OR an `EXISTS` subquery against `orchestration.approvals` matches (a row on this run whose `requested_from_user_id = auth.uid()`, i.e. runs assigned to them for approval). There is no `run_access` join table; the `enduser_read_own_or_approval` policy (migration `20260506000001`) does this inline. See `docs/auth-model.md`.
- `run_steps`, `tool_calls`: same visibility as the parent `run`.
- `artifacts`: same visibility as the parent `run`, with optional per-artifact override (some artifacts may be ops-only even within a visible run; e.g., raw API responses with PII).
- `approvals`: ops can read all. End users can read/update rows where `requested_from = auth.uid()` or they hold the requested role.

The runtime (Workers) uses the **service role key** and bypasses RLS. This is intentional; the runtime is trusted. The dashboard **never** uses the service role key. Mixing these is the most likely security mistake; guard it.

## Migration philosophy

- Forward-only. Never edit an applied migration; add a new one.
- Each migration includes its rollback as a comment, not as an executable. Rollback is a deliberate human act.
- Schema changes that affect runs in flight: write a one-paragraph migration story in the PR explaining what happens to existing runs.
- New tables ship with their RLS policies in the same migration. A table without RLS does not get merged.

## What's intentionally not here

- Eval / model output quality data. Will come when we add eval infrastructure.
- Cost attribution per orchestration. We have token counts on `run_steps`; aggregation can be a view later.
- Multi-tenant isolation (org_id columns). Single-company today. If this becomes multi-tenant, every table above grows an `org_id` and RLS gets a tenant clause.
