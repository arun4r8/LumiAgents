# Roadmap

> **Live board:** the [LumiAgents Delivery Board](https://github.com/orgs/LumitureLabs/projects/1) (org Project) tracks day-to-day work — roadmap follow-ups plus ideas/todos captured from team chats — grouped by status (Current / Backlog / Blocked / Done). This doc stays the authoritative narrative for the phase plan; the board is the working tracker.

Five phases. When work spans phases, finish the current one first. As of 2026-07 Phases 0–3 are shipped and Phase 4 (ongoing migration) is the live one; a large body of capability has shipped on top of the plan; see "Shipped beyond the original plan" below.

## Phase 0: Decisions and inventory  [DONE]

Outputs:

- `docs/n8n-inventory.md`, covering every existing flow: name, trigger, inputs, outputs, integrations touched, owner, run frequency. Mark each as KEEP / WRAP / MIGRATE-LATER.
- `docs/integrations-inventory.md`, covering every external system: auth model, rate limits, credential owner, sandbox availability.
- `docs/orchestrations-target.md`: the 5–10 multi-step things the company actually does that span flows or need judgment. **This is the real product surface.** The individual n8n flows are infrastructure.
- `docs/auth-model.md`: who logs in, what role, what they can see/trigger. Drives RLS design.
- `docs/supabase-audit.md`: current schema, what's n8n's, what's app data, what RLS exists, what doesn't.

Exit criteria: a human can read these and predict what Phase 1 will produce.

## Phase 1: Data layer rearchitecture  [DONE]

- New `orchestration` schema in Supabase per `docs/data-model.md`.
- RLS policies for all new tables, in the same migrations.
- Domain tables (the actual business data) split out from telemetry. Migrations from current state, written carefully.
- Seed data and a local Supabase setup script so dev can come up clean in one command.
- A read-only "compatibility view" if any existing app code reads n8n's tables directly; we want the new schema to be the source of truth going forward.

Exit criteria: schema is in place, RLS tested with both ops and end-user JWTs, migrations apply cleanly forward.

## Phase 2: Orchestration runtime on Workers  [DONE]

- `/runtime/`: workflow runner built on Cloudflare Workflows. The four primitives (`step`, `llm_decide`, `llm_extract`, `await_approval`) implemented and tested.
- `/integrations/n8n/`: typed wrappers for the WRAP-flagged n8n flows from Phase 0.
- One real orchestration end-to-end. Pick the highest-value one from `orchestrations-target.md`. Resist the urge to generalize until this works.
- Trigger surface: HTTP endpoint + cron + queue.
- Wrangler config, deploy pipeline, dev environment.

Exit criteria: the chosen orchestration runs in dev, logs land in the new schema, retries and resumes work correctly.

## Phase 3: Dashboard  [DONE]

- Next.js + Cloudflare Pages + shadcn/ui.
- Auth via Supabase. Role detection drives view selection.
- Ops surface: runs list, run detail (timeline + step inputs/outputs), tool call log, error dashboard, retry/cancel.
- End-user surface: orchestration catalog (filtered by access), schema-driven forms, "my runs", approval inbox.
- Realtime updates for in-flight runs (Supabase Realtime subscribed to `run_steps`).

Exit criteria: an end user can trigger an orchestration via the dashboard, watch it progress, and approve a step. An ops user can see everything and intervene on failures.

## Phase 4: Migrate flows from n8n into Workers (ongoing)  [CURRENT]

For each MIGRATE-LATER flow, in priority order:
- Reimplement in Worker code as a tool (or set of tools).
- Swap the integration wrapper's implementation.
- Run both old and new in parallel for one production cycle, comparing outputs (shadow mode).
- Cut over. Delete the n8n flow.

Done when n8n only handles cases it's uniquely good at: visual editing for non-devs, niche connectors. There is no goal of fully retiring n8n.

## Shipped beyond the original plan  [DONE]

Capability that landed on top of the five-phase spine, all running on the Workers runtime:

- **Agent memory:** conversations, messages, and `memory_chunks` (pgvector) with a daily `system/memory-maintenance` orchestration.
- **Awards agent + digests (Cleo):** `cleo/award-sweep` (weekly Tavily sweep → `awards`) and `cleo/award-report` (daily digest).
- **RFI / Sources Sought drafting:** `beady/rfi-draft`, grounded in SAM.gov notice text + attachments and past performance (moved to Beady from Cleo).
- **Industry days:** `beady/industry-day-sweep` (SAM.gov Special Notices + Tavily → `industry_days`) with an `/industry-days` dashboard page.
- **Content calendar + CSV import (Cleo):** `content_calendar` populated by manual add, `plan_calendar`, or idempotent CSV import (`source_key`); `cleo/content-draft` + `cleo/content-nudge`. No auto-publish.
- **Unified subscriptions:** one `orchestration.subscriptions` table with a `kind` discriminator ('opportunity' | 'award'), replacing the now-deprecated `report_subscriptions` + `award_subscriptions` (kept only as a rollback net).
- **Knowledge corpus/sensitivity separation + Dewey:** `corpus` and `sensitivity` columns on `orch_documents`/`document_chunks`, runtime-enforced retrieval scoping (`knowledge-access.ts`), and the Dewey librarian orchestrations (`knowledge-search`, `retag-document`, `knowledge-inventory`).
- **Email alerts:** operational failure and "due soon" alerts go by email to subscription recipients via Resend (`sendAlertEmail`), not Teams. The Teams incoming webhook is no longer used for alerts.

## Known external blocker

- **SBIR source unavailable:** the DoD SBIR/STTR portal migrated to `www.defensesbirsttr.mil` behind Akamai bot-protection (403 to server-side calls) and the SBIR.gov public API is disabled. `beady/sbir-topic-search` and the SBIR half of `beady/opportunity-sweep` are correct in code but externally blocked. The Beady sweep health alert deliberately does not page on this known outage.

## Open follow-ups

- **Microsoft Graph live sync for the content calendar:** CSV import is the interim path; a live Graph sync is the intended upgrade, not yet built.
- **Enduser tier not yet used:** the `enduser` role is enforced (RLS + route guards) but has no accounts; everything today is ops.
- **Per-agent knowledge corpora are opt-in:** the corpus/sensitivity model is in place, but tagging documents to private corpora is opt-in and most content stays `shared`.

## Out of scope (for now)

Track these here so we don't accidentally do them:

- Multi-tenancy. Single company today.
- Eval / model output quality infrastructure. Add when Phase 2's first orchestration is running and we have decisions to evaluate.
- A "chat with the orchestration layer" interface. Considered, but the dashboard's structured surface comes first.
- OpenTelemetry. Workers Logs + Supabase logs are enough until they aren't.
- Public API. Internal only.
- A `/skills/` framework for end-user-defined automations. Way too early.
