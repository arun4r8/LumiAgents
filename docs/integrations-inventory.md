# Integrations Inventory

All external systems touched by the orchestration layer or existing n8n workflows. Last updated: 2026-05-06.

## Google Gemini (via Google AI / Vertex AI)
**Credential type in n8n:** `googlePalmApi`  
**Used by:** GovCon Assessment, Resume Scoring, LumiAnalysis, Agent Beady  
**Usage:** Chat completions, information extraction, embeddings (text-embedding-gecko)  
**Auth model:** API key (Google AI Studio) or service account (Vertex AI)  
**Rate limits:** Gemini 1.5 Pro — 1000 RPM / 1M TPM on paid tier  
**Sandbox:** Yes — separate API key per environment  
**Credential owner:** TBD — confirm with Arun  
**Orchestration layer plan:** Migrate to Anthropic API (`llm_decide` / `llm_extract`). Gemini stays as n8n-internal until flows are migrated. Do not call Gemini directly from Workers.

---

## Anthropic API
**Credential type in n8n:** `anthropicApi`  
**Used by:** Resume Formatting Automation  
**Usage:** Claude Sonnet 4.5 — resume formatting agent  
**Auth model:** API key  
**Rate limits:** Depends on tier — check console.anthropic.com  
**Sandbox:** Use a separate API key for dev/staging  
**Credential owner:** Arun  
**Orchestration layer plan:** Primary LLM for all `llm_decide` / `llm_extract` calls in Workers. Use `claude-sonnet-4-6` (latest). Always log via `run_steps`.

---

## Supabase
**Credential type in n8n:** `supabaseApi`  
**Used by:** GovCon Assessment, Resume Scoring, LumiAnalysis, LinkedIn Outreach, Inbound Email  
**Usage:** Postgres reads/writes, vector store (pgvector), file storage  
**Auth model:** Service role key (in n8n), anon key + JWT (dashboard)  
**Project:** `cuaknazkpmwvnkmwtamp` (Lumiture, East US - North Virginia)  
**Sandbox:** Separate project (`bbvfjykxxgwlkpnggkup`, "Test") exists — use for dev  
**Rate limits:** Database connection pooling via Supabase — watch for connection exhaustion from Workers  
**Credential owner:** Arun  
**Orchestration layer plan:** Workers use service role key (via Wrangler secret). Dashboard uses anon key + user JWT. Never mix.

---

## Microsoft Teams
**Credential type in n8n:** (OAuth, via n8n built-in)  
**Used by:** Teams Messages & Adaptive Cards  
**Usage:** Post messages, send adaptive cards  
**Auth model:** OAuth2 (Microsoft 365 app registration)  
**Sandbox:** Dev tenant or test channel  
**Credential owner:** TBD  
**Orchestration layer plan:** Wrap `POST /teams-message` and `POST /teams-card` as n8n integration tools. Do not call Microsoft Graph directly from Workers until the n8n flow is MIGRATE-LATER.

---

## Microsoft Outlook
**Credential type in n8n:** `microsoftOutlookOAuth2Api`  
**Used by:** Agent Beady (Jira)  
**Usage:** Email reading/sending  
**Auth model:** OAuth2  
**Credential owner:** TBD  
**Orchestration layer plan:** Via n8n wrapper for now.

---

## Jira (Atlassian Cloud)
**Credential type in n8n:** `jiraSoftwareCloudApi`  
**Used by:** Agent Beady (Jira)  
**Usage:** Ticket creation/updates  
**Auth model:** API token + email  
**Sandbox:** Jira has a free sandbox tier  
**Credential owner:** TBD  
**Orchestration layer plan:** Via n8n wrapper.

---

## GitHub
**Credential type in n8n:** `githubApi`  
**Used by:** Agent Beady (Jira)  
**Usage:** TBD (likely PR/issue linking)  
**Auth model:** Personal access token or GitHub App  
**Credential owner:** TBD  
**Orchestration layer plan:** Via n8n wrapper.

---

## LinkedIn
**Used by:** LinkedIn Recruiter + Daily Autonomous Outreach  
**Usage:** Search, profile scraping, outreach  
**Auth model:** Session cookies / unofficial API (fragile — confirm approach with Arun)  
**Rate limits:** Very aggressive — LinkedIn actively blocks automation  
**Orchestration layer plan:** Treat as high-risk. Keep entirely in n8n. Wrap with conservative rate limiting.

---

## Cloudflare Workers / Workflows
**Used by:** This repo (runtime)  
**Account:** `arun.rajendra@lumiture.com` (Account ID: `6ddb39faef7414bddd0c0993e293f895`)  
**Auth:** OAuth via `wrangler login`  
**Sandbox:** Use Worker environments (`dev`, `staging`, `production`) + separate KV namespaces per env  

---

## SAM.gov / GovCon API (opportunity data)
**Considered:** GovSignals AI (govsignals.ai) — evaluated 2026-05-06 and ruled out.  
GovSignals is a human-facing SaaS with no public API, no webhook output, and no programmatic access path. It cannot be called from a Worker or n8n flow.

**Plan:** Use one of the following for raw opportunity ingestion into Beady's GovCon assessment:
- **SAM.gov API** (api.sam.gov) — free with API key, 1,000 req/day. Returns structured JSON for solicitations, contract awards, and entity registrations. Auth: `api_key` query param.
- **GovCon API** (govconapi.com) — $19–$39/month, 24,000 req/day, 59 fields per notice, cleaner JSON than SAM.gov. Auth: API key.

**Orchestration layer plan:** Add a `sam-gov-opportunity.ts` integration wrapper that calls SAM.gov (or GovCon API) to fetch opportunity details by solicitation number. Beady's `govcon-assessment` orchestration will call this before running the LLM scoring chain, rather than requiring the caller to pre-load the data.

**Note:** If Lumiture subscribes to GovSignals for human BD use, any opportunity IDs or notes from a capture manager's session can be manually entered as inputs to the orchestration. GovSignals remains a human tool; the orchestration layer handles the automated scoring independently.

---

## Credential storage plan (Workers)

| Secret | Wrangler secret name | Used by |
|--------|---------------------|---------|
| Anthropic API key | `ANTHROPIC_API_KEY` | Runtime LLM calls |
| Supabase service role key | `SUPABASE_SERVICE_ROLE_KEY` | Runtime DB writes |
| Supabase URL | `SUPABASE_URL` | Runtime DB |
| n8n API key | `N8N_API_KEY` | Integration wrappers (management only) |
| n8n webhook auth | `N8N_WEBHOOK_SECRET` | Webhook HMAC verification |

All secrets via `wrangler secret put <name>`. Never in `wrangler.toml` or committed files.
