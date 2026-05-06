# Target Orchestrations

The multi-step workflows the company actually runs that span flows or need LLM judgment. These are the product surface. The n8n flows are infrastructure underneath them. Last updated: 2026-05-06.

## How to read this

Each orchestration lists: what it does, what n8n flows it spans, what LLM decision points exist, and what phase it ships in.

---

## 1. GovCon Opportunity Assessment
**Priority:** High — shipping in Phase 2  
**Status:** n8n flow exists and is active (`IgroV8Rw2NGJb3f6`)

**What it does:**  
Given a government contracting opportunity (solicitation docs, SAM.gov link, or manual input), assess whether Lumiture should pursue it. Produce a scored assessment and executive memo. Output: go / no-go recommendation with supporting rationale.

**Steps:**
1. `step`: Ingest opportunity documents → extract to Supabase
2. `llm_extract`: Extract structured opportunity facts (NAICS, set-aside, ceiling, period of performance, agency)
3. `step`: Retrieve capability statements + past performance from vector store
4. `llm_decide`: Score qualification (go / no-go / conditional)
5. `llm_extract`: Generate executive memo
6. `step`: Save assessment to Supabase
7. `await_approval` *(optional)*: Route conditional decisions to ops for manual review

**n8n flows wrapped:**
- `POST /govcon-assessment-intake` — main assessment
- `POST /past-performance-seeder` — seeds past performance docs

**LLM calls:** 3 (extract facts, score, generate memo)  
**Input schema:** `{ opportunityUrl?: string, documents?: File[], notes?: string }`  
**Output schema:** `{ assessmentId: string, score: number, recommendation: 'go' | 'no-go' | 'conditional', memo: string }`  
**Triggered by:** Ops users via dashboard form, or webhook from external intake form  
**Visible to:** ops role

---

## 2. Resume Screening Pipeline
**Priority:** High — shipping in Phase 2  
**Status:** n8n flows exist and are active (`MjkmZrxDnJimxTW6`, `30fumQwU2T6q5An0`)

**What it does:**  
Receives a resume for a job opening. Scores it, formats it to a standard template, and routes it to the right reviewer. Feeds Agent Angie downstream.

**Steps:**
1. `step`: Download resume from storage
2. `llm_extract`: Extract candidate info (name, contact, skills, experience)
3. `step`: Score resume against job description (HR Expert chain)
4. `step`: Format resume to standard template (Claude)
5. `step`: Store results, update process queue
6. `step`: Create Agent Angie task for downstream processing

**n8n flows wrapped:**
- Resume Scoring (`MjkmZrxDnJimxTW6`)
- Resume Formatting Automation (`30fumQwU2T6q5An0`) ← activate first (needs Anthropic credential)

**LLM calls:** 2 (extract, score) + 1 (format via Claude)  
**Input schema:** `{ jobId: string, resumeFile: File }`  
**Output schema:** `{ candidateId: string, score: number, formattedResumeUrl: string, queueItemId: string }`  
**Triggered by:** Webhook (external applicant intake), or dashboard manual upload  
**Visible to:** ops role, hr role

---

## 3. LumiAnalysis Query
**Priority:** High — shipping in Phase 2  
**Status:** n8n flow active (`wRwtElhzpWcbUUlk`)

**What it does:**  
Answer a question using either a document knowledge base (RAG) or structured database tables (SQL agent). Route automatically based on query type. Support ingesting new PDFs and CSVs.

**Steps (query path):**
1. `llm_decide`: Route query to RAG agent or data analyst agent
2. `step`: Execute the appropriate n8n agent (retrieve, synthesize, respond)
3. `step`: Log task to Supabase

**Steps (ingestion path):**
1. `step`: Upload PDF or CSV to appropriate n8n ingestion endpoint
2. `step`: Log ingestion run

**n8n flows wrapped:**
- `POST /PDF-Ingestion`, `POST /CSV-Ingestion`
- `POST /<uuid>` (research agent), `POST /<uuid>` (data analyst agent)

**LLM calls:** 1 (`llm_decide` for routing)  
**Input schema:** `{ query: string, mode?: 'auto' | 'rag' | 'sql' }` or `{ file: File, type: 'pdf' | 'csv' }`  
**Output schema:** `{ answer: string, sources?: string[], runId: string }`  
**Triggered by:** Dashboard chat interface, or API  
**Visible to:** ops role, analyst role

---

## 4. Inbound Comms Triage
**Priority:** Medium — Phase 3  
**Status:** Partially built (Inbound Email Monitoring exists, Teams integration exists)

**What it does:**  
Monitor inbound email and Teams messages. Classify intent (inquiry, task, escalation, noise). Route or auto-respond. Create Jira tickets for actionable items.

**Steps:**
1. `step`: Poll or receive inbound message (email or Teams)
2. `llm_decide`: Classify intent (inquiry / task / escalation / noise)
3. `llm_extract`: Extract action items if applicable
4. `step`: Route — create Jira ticket, post Teams card, send reply, or discard
5. `await_approval`: For escalations, pause and notify ops

**n8n flows wrapped:**
- Inbound Email Monitoring (`E4WYbbvVVZRsOIrT`)
- Teams Messages & Adaptive Cards (`Da6ebpe0EDQOSNm2`)
- Agent Beady / Jira (`8Wh8HBaHokFXUjku`)

**LLM calls:** 2 (classify, extract)  
**Input schema:** `{ source: 'email' | 'teams', messageId: string }`  
**Output schema:** `{ action: 'ticket' | 'reply' | 'card' | 'discard', referenceId?: string }`  
**Triggered by:** Webhook (email arrival, Teams event), or cron poll  
**Visible to:** ops role

---

## 5. LinkedIn Outreach Campaign
**Priority:** Medium — Phase 3  
**Status:** n8n flow exists, inactive (`ByaMXfFp8OcOcYGi`)

**What it does:**  
Given a target profile (role, industry, company size), search LinkedIn for candidates or prospects, draft personalized outreach messages, and send on a schedule.

**Steps:**
1. `step`: Search LinkedIn for matching profiles
2. `llm_extract`: Score/filter profiles against criteria
3. `llm_extract`: Draft personalized outreach message per profile
4. `await_approval`: Human reviews message batch before sending
5. `step`: Send approved messages on schedule

**n8n flows wrapped:**
- `POST /linkedin-search`

**LLM calls:** 2 (filter, draft)  
**Input schema:** `{ targetRole: string, industry: string, criteria: string, messageTemplate: string }`  
**Triggered by:** Dashboard (ops manual trigger)  
**Visible to:** ops role  
**Note:** LinkedIn automation is high-risk. Rate limits and account safety require human approval step before sending.

---

## Out of scope for now

- Web Sentiment Analysis — exists in n8n but no clear owner or trigger cadence. Revisit in Phase 3.
- MVP Builder Agent — prototype, not production-ready.
- GovCon Assessment Agent v1 (`ctpk3drgJpU1BfFJ`) — superseded by the active v2 workflow.
