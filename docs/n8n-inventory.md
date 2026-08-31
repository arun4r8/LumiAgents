# n8n Workflow Inventory

<!-- doc-facts: illustrative -->
<!-- historical inventory of retired n8n flows; scripts/check-doc-facts.py skips existence checks here -->

Phase 0 inventory of all n8n workflows in `lumiture.app.n8n.cloud`. Last updated: 2026-05-06.

## Summary

| Workflow | Active | LLM | Trigger | Priority |
|----------|--------|-----|---------|----------|
| GovCon Qualification Assessment | ✓ | Gemini | `POST /govcon-assessment-intake` | High |
| Resume Scoring | ✓ | Gemini | `POST /<uuid>` | High |
| LumiAnalysis (RAG + Data Analyst) | ✓ | Gemini | `POST /PDF-Ingestion`, `POST /CSV-Ingestion` | High |
| Resume Formatting Automation | ✗ | Claude Sonnet 4.5 | `POST /resume-upload` | High (blocked on credential) |
| LinkedIn Recruiter Outreach | ✗ | None | `POST /linkedin-search` | Medium |
| Teams Messages & Adaptive Cards | ✗ | None | `POST /teams-message`, `POST /teams-card` | Medium |
| Web Sentiment Analysis | ✗ | None | `POST /sentiment-analysis` | Medium |
| Inbound Email Monitoring | ✗ | None | Email trigger | Low |
| OCR | ✗ | None | None | Low |
| Agent Beady (Jira) | ✗ | None | None | Low |
| MVP Builder Agent | ✗ | None | `POST /<uuid>` | Low |
| GovCon Assessment Agent (v1) | ✗ | None | `POST /govcon-intake` | Superseded |
| LumiAnalysis 1st Edition | ✗ | None | None | Superseded |
| Gemini File Search | ✗ | None | None | Archived |

---

## Active Workflows (detailed)

### GovCon Qualification Assessment Workflows
**n8n ID:** `IgroV8Rw2NGJb3f6`

**What it does:** Ingests a government contracting opportunity, runs qualification scoring against the company's capability statements and past performance records, and produces an executive memo with a go/no-go recommendation.

**Webhook endpoints:**
- `POST /govcon-assessment-intake`: main entry point, triggers full assessment
- `POST /past-performance-seeder`: loads past performance records into vector store

**Integrations:**
- Supabase (Postgres + Vector Store): stores opportunities, capability statements, past performance, assessments, prompt bank
- Google Gemini: information extraction, embeddings, LLM chain for scoring and memo

**Credential types:** `googlePalmApi`, `supabaseApi`

**Key data flows:**
1. Receive opportunity docs → extract structured facts (Gemini)
2. Embed and store in Supabase vector store
3. Retrieve capability statements + past performance via vector search
4. Score qualification → produce executive memo
5. Save assessment to Supabase

**Orchestration notes:** 76 nodes, a complex multi-step flow with branching. Prime candidate for an orchestration wrapper with `llm_decide` at the go/no-go step and `llm_extract` for opportunity fact extraction.

---

### Resume Scoring Workflow
**n8n ID:** `MjkmZrxDnJimxTW6`

**What it does:** Receives a resume file, scores it against a job, queues it for processing, stores results, and creates a downstream task for Agent Angie.

**Webhook endpoints:**
- `POST /<uuid>`: main entry (UUID-based, not a named path)

**Integrations:**
- Supabase: job records, process queue, resume results, file storage (via REST)
- Google Gemini: resume content extraction, candidate info extraction, HR scoring chain

**Credential types:** `googlePalmApi`, `supabaseApi`

**Key data flows:**
1. Receive resume → download binary from Supabase storage
2. Extract resume content + candidate info (Gemini information extractors)
3. Score against job description (HR Expert LLM chain)
4. Store results → update queue → create Agent Angie task

**Orchestration notes:** 38 nodes. Feeds downstream to "Agent Angie", which suggests a multi-agent pipeline. The process queue pattern maps well to `run_steps`.

---

### LumiAnalysis (Data Analyst & Document RAG) Agents
**n8n ID:** `wRwtElhzpWcbUUlk`

**What it does:** Dual-agent system, pairing a document RAG agent for research queries with a data analyst agent for database/CSV queries.

**Webhook endpoints:**
- `POST /PDF-Ingestion`: ingest a PDF into the knowledge base
- `POST /CSV-Ingestion`: ingest a CSV into the DB table
- `POST /63472a97...`: research agent query endpoint
- `POST /c3f6812b...`: data analyst agent query endpoint

**Integrations:**
- Supabase: vector store, DB tables, task logging
- Google Gemini: embeddings, chat model for both agents, buffer memory

**Credential types:** `googlePalmApi`, `supabaseApi`

**Key data flows:**
1. Ingestion path: PDF/CSV → chunk → embed → store in Supabase vector store / DB table
2. Query path: user query → agent decides RAG vs SQL → retrieve → respond

**Orchestration notes:** 35 nodes. The two ingestion endpoints and two query endpoints are natural integration wrapper boundaries. The agent's tool-use pattern here can be mapped directly to the tool registry.

---

## Inactive Workflows to Activate

### Resume Formatting Automation
**n8n ID:** `30fumQwU2T6q5An0`

**What it does:** Receives a resume PDF, uses Claude to reformat it per criteria and target role, generates an HTML resume, converts to PDF, and returns it.

**Webhook:** `POST /resume-upload`

**Inputs:**
- `formattingCriteria: string` (e.g. "ATS-friendly, two pages max")
- `targetRole: string` (e.g. "Senior Software Engineer")
- Resume PDF (binary, multipart)

**Output:** Formatted resume PDF (binary response)

**LLM used:** Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`)

**Credential types needed:** `anthropicApi` (Anthropic API key; **currently missing, workflow is inactive because of this**)

**Fix required:**
1. In n8n, go to **Credentials → New → Anthropic**
2. Add your Anthropic API key
3. Open the workflow, click the **Anthropic Chat Model** node, assign the credential
4. Activate the workflow

No other credentials are needed: this workflow is self-contained (no Supabase, no Google).

---

## Credential Summary

| Credential Type | Used By | Status |
|----------------|---------|--------|
| `googlePalmApi` | GovCon, Resume Scoring, LumiAnalysis | Set (workflows are active) |
| `supabaseApi` | GovCon, Resume Scoring, LumiAnalysis | Set (workflows are active) |
| `anthropicApi` | Resume Formatting Automation | **Missing; needs to be added** |

---

## Phase 0 Recommendations

**First orchestrations to build (in order):**
1. `govcon-assessment`: highest complexity, most business value, clear inputs/outputs
2. `resume-scoring`: well-defined queue pattern, feeds multi-agent pipeline
3. `lumi-analysis`: dual ingestion + query pattern, good for RAG tooling
4. `resume-formatting`: simplest, self-contained, good first integration once credential is fixed

**Integration wrappers needed (`/integrations/n8n/`):**
- `govcon-assessment-intake.ts`
- `past-performance-seeder.ts`
- `resume-scoring.ts`
- `pdf-ingestion.ts` / `csv-ingestion.ts`
- `resume-upload.ts`

**Supabase tables referenced by n8n (needs schema audit):**
- opportunities
- capability_statements
- past_performance
- opportunity_documents
- assessments
- prompt_bank
- process_queue
- resume_results
- db_tables (LumiAnalysis data)
