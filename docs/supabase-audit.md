# Supabase Audit

Current state of the Lumiture Supabase project. Last updated: 2026-05-06.

**Project:** Lumiture (`cuaknazkpmwvnkmwtamp`) — East US (North Virginia)  
**Postgres:** 17.6  
**pgvector:** Enabled — embeddings at 3072 dimensions (Gemini text-embedding models)

---

## Existing tables (public schema)

30 tables. Grouped by domain.

### GovCon / Business Development
| Table | Purpose | Rows | Notes |
|-------|---------|------|-------|
| `opportunities` | Opportunity records | 0 | Core BD table |
| `opportunity_documents` | Docs per opportunity | 0 | Raw text + metadata |
| `opportunity_documents_vt` | Vector store for opp docs | 0 | 3072-dim embeddings |
| `assessments` | Go/no-go assessment results | 0 | Links opportunity + company_profile |
| `capability_statements` | Company capabilities | 0 | Used in vector similarity |
| `company_profiles` | Company profile | 0 | Anchor for capabilities + past perf |
| `past_performance` | Past performance records | 2 | Seeds vector store |
| `past_performance_vt` | Vector store for past perf | 0 | 3072-dim embeddings |
| `icp_profiles` | Ideal customer profiles | 0 | Target agency/domain criteria |
| `incumbent_research` | Incumbent contractor data | 0 | Linked to opportunities |
| `prompt_bank` | LLM prompt templates | 0 | Used by GovCon assessment |

### Contracts / Finance
| Table | Purpose | Rows | Notes |
|-------|---------|------|-------|
| `contracts` | Contract records | 0 | Links to opportunities |
| `budget_lines` | CLIN-level budget | 0 | Budgeted/obligated/expended |
| `invoices` | Invoice records | 0 | Links to contracts |
| `labor_records` | Labor charging | 0 | Employee + contract + hours |
| `indirect_rates` | Indirect rate structure | 0 | Fringe, overhead, G&A by FY |

### Resume / Recruiting
| Table | Purpose | Rows | Notes |
|-------|---------|------|-------|
| `candidates` | Candidate records | 0 | LinkedIn/manual |
| `resume_jobs` | Batch scoring jobs | 0 | One per job opening |
| `resume_queue` | Resume processing queue | 0 | Locked-by pattern for dequeue |
| `resume_results` | Scored resume output | 0 | Detailed scoring breakdown |

### Employees / HR
| Table | Purpose | Rows | Notes |
|-------|---------|------|-------|
| `employees` | Employee records | 0 | Has Jira + GitHub fields |
| `staff_requests` | HR requests | 0 | Links to Jira issues |

### Agent / AI Telemetry (n8n-era)
| Table | Purpose | Rows | Notes |
|-------|---------|------|-------|
| `agent_tasks` | Task records for agents | 3 | Predecessor to `runs` |
| `agent_logs` | Per-step agent logs | 0 | Predecessor to `run_steps` |
| `documents` | Generic doc + embedding store | 0 | 3072-dim |
| `records` | Generic records store | 0 | |

### Comms Logs
| Table | Purpose | Rows | Notes |
|-------|---------|------|-------|
| `call_logs` | Call records | 0 | |
| `email_logs` | Email records | 0 | |
| `sms_logs` | SMS records | 0 | |

### Auth (custom — see security note)
| Table | Purpose | Rows | Notes |
|-------|---------|------|-------|
| `users` | Custom user table | 0 | Has username + password columns ⚠️ |

---

## RLS status

Anon key returns `[]` for all tables including those with data (agent_tasks has 3 rows, invisible to anon). This indicates RLS is enabled with deny-all defaults on at least the data tables. **Full RLS audit requires direct Postgres access** (currently blocked by IPv6 — see below).

Working assumption: RLS is partially configured but untested at the app layer. Phase 1 will write explicit, tested RLS policies for all orchestration schema tables.

---

## Security flag: custom `users` table ⚠️

The `users` table has `username (varchar)` and `password (varchar)` columns. This means authentication is currently handled outside Supabase Auth, with credentials stored directly in Postgres. This is a risk:

- Passwords visible to anyone with service role access
- No session management, MFA, or OAuth out of the box
- Supabase RLS can't reference `auth.uid()` for these users

**Plan:** Migrate to Supabase Auth in Phase 1. Create Supabase Auth users for existing `users` rows. The `users` table becomes a profile extension table (linked by `auth.uid()`), not an auth table. Password column is removed.

---

## n8n-era vs orchestration-layer tables

The `agent_tasks` and `agent_logs` tables are n8n's predecessor to what the orchestration layer will manage in `orchestration.runs` and `orchestration.run_steps`. They will remain in `public` and are not touched. The new schema is additive.

---

## pgvector

Extension enabled. All vector columns are 3072 dimensions, consistent with Gemini `text-embedding-004` (or OpenAI `text-embedding-3-large`). New orchestration tables do not need vector columns — embeddings stay in the domain tables.

---

## IPv6 / direct Postgres access

The Supabase CLI `db dump` and `db diff` commands require direct Postgres connection. This machine's network does not support IPv6, which the direct connection host (`db.cuaknazkpmwvnkmwtamp.supabase.co`) resolves to. **Workaround:** use the Supabase Management API for schema introspection (done above), and run migrations via `supabase db push` which uses the HTTP API rather than a direct socket.

---

## What Phase 1 creates

New `orchestration` schema (separate from `public`). No existing tables are modified.

- `orchestration.orchestrations`
- `orchestration.orchestration_access`
- `orchestration.runs`
- `orchestration.run_steps`
- `orchestration.tool_calls`
- `orchestration.artifacts`
- `orchestration.approvals`

Each table ships with RLS in the same migration file.
