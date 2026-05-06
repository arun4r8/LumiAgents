# Supabase Audit

Current state of the Lumiture Supabase project. Last updated: 2026-05-06.

**Project:** Lumiture (`jlljpgdqqxljvznjslmb`) — East US (North Virginia)  
**Status:** ⚠️ Project was paused at time of audit. Schema pulled from n8n workflow analysis and runtime observation. Full introspection pending project resume.

---

## What we know from n8n workflow analysis

The following tables are referenced directly by active n8n workflows. These are n8n's operational tables — the orchestration layer will not touch them.

### GovCon Assessment (`IgroV8Rw2NGJb3f6`)
| Table | Operation | Notes |
|-------|-----------|-------|
| opportunities | INSERT, SELECT | Opportunity records |
| capability_statements | SELECT | Used in vector similarity search |
| past_performance | INSERT, SELECT | Seeded via separate webhook |
| opportunity_documents | INSERT, SELECT | Attached files per opportunity |
| assessments | INSERT | Final go/no-go assessment output |
| prompt_bank | SELECT | LLM prompt templates stored in DB |
| (vector store) | INSERT, SELECT | pgvector embeddings for capabilities + past perf |

### Resume Scoring (`MjkmZrxDnJimxTW6`)
| Table | Operation | Notes |
|-------|-----------|-------|
| jobs | INSERT, SELECT, UPDATE | Job posting records |
| process_queue | INSERT, SELECT, UPDATE | Resume processing queue |
| resume_results | INSERT | Scored resume output |
| (storage) | GET, DELETE | Resume files in Supabase Storage |

### LumiAnalysis (`wRwtElhzpWcbUUlk`)
| Table | Operation | Notes |
|-------|-----------|-------|
| db_tables | INSERT | CSV data uploaded by users |
| (vector store) | INSERT, SELECT | Document embeddings |
| (task log) | INSERT | Agent task logging |

### Inbound Email + LinkedIn (`E4WYbbvVVZRsOIrT`, `ByaMXfFp8OcOcYGi`)
| Table | Operation | Notes |
|-------|-----------|-------|
| (unknown) | Unknown | Supabase referenced but tables not identified from node names |

---

## RLS status (known)

All existing tables were created by n8n's service role key access. RLS status is unknown until project is unpaused and schema is introspected. **Assume no RLS on existing tables until verified.**

---

## New schema: `orchestration` (to be created in Phase 1)

The orchestration layer adds a new schema alongside `public`. No existing n8n tables are modified.

Tables to create (per `docs/data-model.md`):
- `orchestration.orchestrations`
- `orchestration.runs`
- `orchestration.run_steps`
- `orchestration.tool_calls`
- `orchestration.artifacts`
- `orchestration.approvals`
- `orchestration.orchestration_access`

Each table ships with RLS in the same migration. See `docs/data-model.md` for full column specs and RLS policies.

---

## Supabase Storage buckets (known)

- At least one bucket used for resume files (referenced by Resume Scoring workflow via HTTP REST calls to storage API)
- Bucket name(s) TBD — introspect when project is unpaused

---

## pgvector

pgvector extension is in use (confirmed from GovCon and LumiAnalysis workflows using `vectorStoreSupabase` nodes). Extension is already enabled on the project.

---

## Action items

- [ ] **Unpause project** at https://supabase.com/dashboard/project/jlljpgdqqxljvznjslmb
- [ ] Run `supabase db dump --schema public` to get full schema
- [ ] Audit RLS on existing tables — flag any table with no RLS policy
- [ ] Identify storage bucket names
- [ ] Confirm pgvector version and embedding dimensions in use
- [ ] Update this doc with introspected schema
