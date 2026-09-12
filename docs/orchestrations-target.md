# Target Orchestrations

The multi-step workflows the company actually runs that span flows or need LLM judgment. These are the product surface. This started as a Phase 0 wish-list of "the 5–10 things the company actually does"; almost all of it is now built and running on the Workers orchestration runtime, registered in `runtime/src/registry.ts`. n8n is legacy infrastructure underneath, only where a flow hasn't been migrated. Last updated: 2026-07-20.

## How to read this

Each orchestration lists: what it does, its registered orchestration name(s), how it's triggered, what LLM decision points exist, and its status (BUILT vs planned). The reality in 2026-07 is that most are BUILT; this doc has caught up to the code.

**Trigger modes.** Registered orchestrations are one (or more) of:
- **agent**: invokable by the owning agent mid-conversation (`triggerMode: "agent"`), and usually from the dashboard too.
- **scheduled**: fired by the **meta-cron** (`*/5 * * * *`), which reads `orchestration.schedules` and dispatches rows whose cron matches, guarded by `last_run_at`. Digest cadence (daily/weekly) is honored per-subscription.
- **form / HTTP**: triggered by an ops user via a dashboard form or `POST /api/orchestrations/{name}/run`.

Six agents own orchestrations today: **Angie** (HR/recruiting), **Beady** (GovCon BD), **Cleo** (eminence/awards/content), **Dewey** (knowledge librarian), **Money** (finance/analytics), **Patch** (IT ops/knowledge). Plus a `system/` namespace for platform housekeeping.

---

## 1. GovCon Opportunity Discovery & Assessment  (Beady)
**Status:** BUILT

**What it does:**
Discover federal contracting opportunities across sources, score them, and produce go/no-go assessments with an executive memo. `assess_opportunity` runs a 5-dimension go/no-go against Lumiture's capability statements and past performance.

**Registered orchestrations:**
- `beady/opportunity-sweep`: **scheduled** consolidated SAM.gov + SBIR sweep that writes to `opportunities` and dedups via `orchestration.scored_notices`. Replaced the two older per-source Monday crons.
- `beady/govcon-assessment`: the scored go/no-go assessment + memo (form / agent), saved to `govcon_assessments`.
- `beady/past-performance-seed`: seeds past-performance docs used to ground assessments.

**LLM decision points:** extract structured opportunity facts, score qualification, generate memo.
**Visible to:** ops role.
**External blocker:** SBIR discovery is currently unavailable: the DoD portal moved to `www.defensesbirsttr.mil` behind Akamai bot-protection (403 to server-side calls) and the SBIR.gov public API is disabled. The code targets the new host correctly; the source is down. The sweep health alert deliberately does not page on this known outage.

---

## 2. RFI / Sources Sought Drafting  (Beady)
**Status:** BUILT (new)

**What it does:**
Draft a Sources Sought / RFI response for an opportunity, grounded in Lumiture's company profile and past performance. Ownership moved here from Cleo. The draft lands in `rfi_drafts`; a human edits and submits. No auto-submission.

**Registered orchestrations:**
- `beady/rfi-draft`: **agent** (also dashboard). Grounds the draft in SAM.gov notice text and attachments (`integrations/sam-gov/attachments.ts`) plus past performance.

**LLM decision points:** draft response copy grounded in retrieved solicitation + capability material.
**Visible to:** ops role.

---

## 3. Industry Day Sweep  (Beady)
**Status:** BUILT (new)

**What it does:**
Find relevant industry days / matchmaking events. Sweeps SAM.gov Special Notices (`ptype=s`) plus a Tavily web sweep, scores relevance with an LLM, and writes to `industry_days` (deduped via `industry_day_scored`). Surfaced on the `/industry-days` dashboard page.

**Registered orchestrations:**
- `beady/industry-day-sweep`: **scheduled** (weekly, Mon ~10:00 UTC via meta-cron) and **agent**-invokable.

**LLM decision points:** relevance score per candidate event.
**Visible to:** ops role.

---

## 4. Opportunity Digest  (Beady)
**Status:** BUILT (new)

**What it does:**
Email matching opportunities (at or above each subscription's fit threshold) to report subscribers, honoring per-subscription cadence, threshold, and filters.

**Registered orchestrations:**
- `beady/opportunity-report`: **scheduled** daily digest (~13:00 UTC via meta-cron), reads `kind='opportunity'` rows from the unified `orchestration.subscriptions` table. Manual "Send now" passes `{subscriptionId}` and ignores cadence.

**Delivery:** shared Resend `sendEmail`, per-agent sender (`Beady <…>`).
**Visible to:** ops role.

---

## 5. Awards & Eminence Sweep  (Cleo)
**Status:** BUILT (new)

**What it does:**
Discover industry recognition and government small-business awards, score them, and email a digest to award subscribers.

**Registered orchestrations:**
- `cleo/award-sweep`: **scheduled** (weekly, Mon ~09:00 UTC) Tavily-backed sweep into `awards` (deduped via `orchestration.award_scored`).
- `cleo/award-report`: **scheduled** daily digest (~14:00 UTC), reads `kind='award'` rows from `orchestration.subscriptions`; honors cadence. Manual "Send now" by `{subscriptionId}`.

**LLM decision points:** relevance/quality score per award.
**Visible to:** ops role.

---

## 6. Content Calendar & Drafting  (Cleo)
**Status:** BUILT (new)

**What it does:**
Drive LinkedIn/eminence content. The `content_calendar` table is populated by manual add, `plan_calendar` (theme → idea rows), or **CSV import** (`dashboard/lib/content-csv.ts`; `source_key` makes re-import idempotent and preserves existing drafts). Drafting is grounded only in the company profile. A human approves; there is **no auto-publish**.

**Registered orchestrations:**
- `cleo/content-plan`: **agent**. Theme → calendar idea rows.
- `cleo/content-draft`: **agent**. Post copy + asset brief for a calendar row.
- `cleo/content-nudge`: **scheduled** daily (~09:00 UTC). Emails subscribers about posts due soon that aren't drafted yet (delivery is email via `sendAlertEmail`).

**Visible to:** ops role.
**Note:** A live Microsoft Graph sync is **not** built. CSV export is the interim path; Graph is the future upgrade.

---

## 7. Knowledge Librarian  (Dewey)
**Status:** BUILT (new)

**What it does:**
Steward the shared knowledge corpus. Agents all execute as Postgres `service_role`, so "which agent may read which knowledge" is enforced in the runtime retrieval path (`runtime/src/agents/knowledge-access.ts`), not in Postgres roles. Documents carry a `corpus` (`shared` or an agent slug) and `sensitivity` (`internal` default / `restricted` ops-only). `orchestration.match_document_chunks(...)` filters on both.

**Registered orchestrations:**
- `dewey/knowledge-search`: **agent**. Search over the shared corpus.
- `dewey/retag-document`: **agent**. Change a document's corpus / sensitivity.
- `dewey/knowledge-inventory`: **agent**. Inventory of documents and their tags.

**Visible to:** ops role.
**Note:** Per-agent private corpora tagging is opt-in; most content stays `shared`.

---

## 8. Resume Screening Pipeline  (Angie)
**Status:** BUILT

**What it does:**
Source candidates, score resumes against a job description, and format them to a standard template, feeding Angie's downstream recruiting workflow.

**Registered orchestrations:**
- `angie/candidate-sourcing`: Apollo-backed sourcing.
- `angie/resume-scoring`: score resume vs. job description.
- `angie/resume-format`: format to standard template (Claude).

**LLM decision points:** extract candidate info, score, format.
**Triggered by:** dashboard upload / form (ops), agent.
**Visible to:** ops role.

---

## 9. LumiAnalysis Query & Financial Reporting  (Money)
**Status:** BUILT

**What it does:**
Answer questions against structured database tables and generate financial reports.

**Registered orchestrations:**
- `money/data-analyst`: query structured data.
- `money/financial-report`: generate a financial report.

**LLM decision points:** query interpretation / synthesis.
**Visible to:** ops role.

---

## 10. Document RAG & Inbound Ops  (Patch)
**Status:** BUILT

**What it does:**
Ingest and query documents (RAG), triage inbound comms, and manage tickets / staffing requests.

**Registered orchestrations:**
- `patch/document-rag`: ingest (`documentIngest`) + query (`documentQuery`). Embeddings via Cloudflare Workers AI `@cf/baai/bge-large-en-v1.5` (1024-dim, pgvector ivfflat cosine).
- `patch/inbound-triage`: classify inbound intent and route (Jira ticket, reply, card, discard).
- `patch/ticket-ops`: create/update/search tickets.
- `patch/staff-request`: staffing requests.

**LLM decision points:** routing (`llm_decide`), classification, extraction.
**Visible to:** ops role.

---

## 11. Agent Memory Maintenance  (system)
**Status:** BUILT (new)

**What it does:**
Platform housekeeping for agent memory (conversations, messages, memory_chunks) so long-term recall stays useful.

**Registered orchestrations:**
- `system/memory-maintenance`: **scheduled** daily (12:30 UTC).

**Visible to:** ops role.

---

## Out of scope / not built

- **LinkedIn Outreach Campaign**: profile search + personalized outreach with a human approval gate. Not built; LinkedIn automation stays high-risk. (Candidate *sourcing* via Apollo is built for Angie; outbound outreach is not.)
- **Microsoft Graph live content sync**: the content calendar syncs via CSV import today; a live Graph sync is the future upgrade path, not yet built.
- **Enduser tier**: the `enduser` role exists and is enforced (RLS + route guards) but is not yet used; all current accounts are ops.
- **Per-agent knowledge corpora**: supported (corpus/sensitivity columns + runtime scoping) but tagging is opt-in; most content is `shared`.
- **Web Sentiment Analysis** / **MVP Builder Agent**: still parked; no owner or production path.
