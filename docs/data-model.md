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

Domain tables (the actual business data your orchestrations operate on) live in their own schema, separate from this telemetry. Don't conflate them.

## Why this shape

- **`runs` and `run_steps` separated:** lets you query "all failed steps of type llm_decide last week" without scanning run JSON blobs.
- **`tool_calls` separate from `run_steps`:** a single step may make several tool calls (e.g., a retry). Keeping them flat makes audit and cost analysis tractable.
- **Orchestrations are versioned:** a run records the version it executed against. Changing an orchestration definition does not retroactively change history.
- **`approvals` as first-class:** human-in-the-loop is a known case, not an afterthought. The runtime pauses the workflow and creates an approval row; the dashboard renders it; resolution resumes the workflow.

## RLS (read these policies before writing new ones)

Two roles matter at the database level: `ops` and `enduser`. The dashboard's Supabase client authenticates as the user; their JWT carries their role(s).

- `orchestrations`: ops can read/write all. End users can read rows where `is_active = true` AND they are in the orchestration's allow-list (stored in a join table `orchestration_access`).
- `runs`: ops can read/write all. End users can read runs where `triggered_by = auth.uid()` OR they have explicit access via `run_access` join table (used for runs assigned for approval).
- `run_steps`, `tool_calls`: same visibility as the parent `run`.
- `artifacts`: same visibility as the parent `run`, with optional per-artifact override (some artifacts may be ops-only even within a visible run — e.g., raw API responses with PII).
- `approvals`: ops can read all. End users can read/update rows where `requested_from = auth.uid()` or they hold the requested role.

The runtime (Workers) uses the **service role key** and bypasses RLS — this is intentional, the runtime is trusted. The dashboard **never** uses the service role key. Mixing these is the most likely security mistake; guard it.

## Migration philosophy

- Forward-only. Never edit an applied migration; add a new one.
- Each migration includes its rollback as a comment, not as an executable. Rollback is a deliberate human act.
- Schema changes that affect runs in flight: write a one-paragraph migration story in the PR explaining what happens to existing runs.
- New tables ship with their RLS policies in the same migration. A table without RLS does not get merged.

## What's intentionally not here

- Eval / model output quality data. Will come when we add eval infrastructure.
- Cost attribution per orchestration. We have token counts on `run_steps`; aggregation can be a view later.
- Multi-tenant isolation (org_id columns). Single-company today. If this becomes multi-tenant, every table above grows an `org_id` and RLS gets a tenant clause.
