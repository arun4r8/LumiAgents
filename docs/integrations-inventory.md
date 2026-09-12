# Integrations Inventory

All external systems touched by the orchestration layer. The n8n migration is complete. The runtime calls these APIs directly from Cloudflare Workers; there are no remaining "call it via n8n" wrappers. Last updated: 2026-07-20.

## Anthropic API (Claude)
**Used by:** every LLM decision/extraction/drafting step across all six agents
**Integration code:** `integrations/anthropic/`
- `rfi.ts`: Beady's RFI / Sources Sought response drafter (grounded only in the company profile + past-performance records; never invents facts)
- `content.ts`: Cleo's eminence-calendar content drafter (`draftContentPost`, `planContentIdeas`)
- `govcon.ts`: the GovCon assessment chain (`extractOpportunityFacts`, `scoreDimension`, `scoreQualification`, `writeExecutiveMemo`) plus `pdfToText` OCR
- `score-resume.ts`: Angie's resume scoring rubric
**Models:** default `claude-sonnet-4-6`; `claude-haiku-4-5` for cheaper OCR / summaries / resume scoring
**Auth model:** API key
**Env:** `ANTHROPIC_API_KEY`
**Note:** all LLM calls use tool-use for structured JSON and are logged via `run_steps`.

---

## Supabase
**Used by:** the entire platform, for runtime persistence, dashboard, RAG + agent memory (pgvector), and file storage
**Usage:** Postgres reads/writes across the `orchestration` and `public` schemas, vector store, storage
**Auth model:** service role key (runtime, via Wrangler secret), anon key + user JWT (dashboard)
**Project:** `cuaknazkpmwvnkmwtamp` (Lumiture, East US, North Virginia); separate "Test" project (`bbvfjykxxgwlkpnggkup`) for dev
**Env:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (runtime); `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (dashboard); `SUPABASE_JWT_SECRET` (JWT verification)
**Note:** agents have no DB identity; all runtime queries run as `service_role` and bypass RLS. Knowledge access separation (corpus / sensitivity) is enforced in the retrieval path, not by Postgres roles.

---

## SAM.gov (federal opportunity data)
**Used by:** Beady, for opportunity search/sweep, industry-day sweep, and RFI grounding
**Integration code:** `integrations/sam-gov/`
- `opportunity-search.ts`: SAM.gov Opportunities API v2. Filters by NAICS (`ncode`, one code per request, so a multi-code search fans out into one paged query per code), posted-within-days (`postedFrom`/`postedTo`), open-only (`rdlfrom`/`rdlto` on the response deadline), title text (`title`), and `ptype` codes (`o`=Solicitation, `p`=Presolicitation, `r`=Sources Sought, `k`=Combined Synopsis/Solicitation). Agency is a client-side substring filter on the returned notices; SAM's own `deptname`/`subtier` are deprecated. Pages via `offset`, which is a **page index** and not a record offset (`limit` is records *per page*), so the page size is constant for a whole walk; claiming one unit of the daily budget per request. Returns the match-set size (`totalRecords`, plus `matchedByNaics`) alongside what it pulled, so a caller can tell sampling from sweeping. The `beady/industry-day-sweep` orchestration queries **Special Notices** directly (`ptype=s`) to find agency industry days.
  **v2 ignores unknown parameters silently** (no error, nothing in the response). A misspelled filter therefore reads as *no filter*: this query sent `naicsCode` (the real name is `ncode`) and `status=active` (documented "Coming Soon", i.e. unimplemented) and consequently swept every notice posted in the window, ~8,500 of them, then scored whichever 50 came back first. Check any new parameter against the [published v2 parameter list](https://open.gsa.gov/api/get-opportunities-public-api/); `runtime/tests/unit/sam-search-query.test.ts` pins the query to documented names.
- `attachments.ts`: fetches a notice's full text (description + PDF **and** .docx attachment text, where the RFI/Sources-Sought questions actually live) to ground `beady/rfi-draft`. Best-effort; unzips .docx via built-in `DecompressionStream`, PDFs via `pdfToText`.
**Auth model:** `api_key` query param
**Rate limits:** free tier, ~1,000 req/day
**Env:** `SAM_GOV_API_KEY`
**Note:** the key rotates roughly every 90 days; expiry breaks the Beady sweep and RFI attachment fetch.

---

## SBIR / STTR (DoD topics)
**Used by:** Beady, via `search_all_opportunities` (`beady/opportunity-sweep`)
**Integration code:** `integrations/sbir/topic-search.ts`
**Usage:** keyword / component / status search over open DoD SBIR-STTR topics
**Auth model:** none (public portal); tracked against a daily budget for visibility
**Env:** `SBIR_API_BASE` (optional override of the API base URL; no redeploy needed if the endpoint shifts again)
**Migration + outage note:** the DoD SBIR/STTR Topics portal migrated from `dodsbirsttr.mil` → `www.defensesbirsttr.mil`; the old apex's DNS A record was pulled, so the code now targets the new host (default base `https://www.defensesbirsttr.mil/topics-app/api/public`) and sends browser-like headers. **As of 2026-07 the source is externally unavailable to server-side callers:** the new host sits behind Akamai bot-protection (403 to Worker calls) and the SBIR.gov public API is disabled. The integration code is correct but the upstream is down; the sweep health alert deliberately does *not* alert on this known outage.

---

## Tavily (web search)
**Used by:** Cleo's award sweep and Beady's industry-day sweep (also GovCon incumbent research, D3)
**Integration code:** `integrations/tavily/search.ts`
**Usage:** thin wrapper over Tavily `/search` (advanced depth, optional domain include-list)
**Auth model:** API key
**Env:** `TAVILY_API_KEY`
**Note:** degrades gracefully: with no key or on error it returns `[]` so the sweep/assessment still completes.

---

## Resend (transactional email)
**Used by:** all digests + operational alerts
**Integration code:** `integrations/resend/`
- `send.ts`: `sendEmail(env, {to, subject, html, from?})`; degrades gracefully if the key is unset
- `sender.ts`: `senderFor(env, slug)` resolves a **per-agent `from`** identity (e.g. `Beady <beady@domain>`) by reusing the verified domain from `RESEND_FROM`; falls back to the shared sender if `RESEND_FROM` is unset or still on the `resend.dev` test domain
- `alert.ts`: `sendAlertEmail` + `subscriptionRecipients(env, kind?)`; failure/health alerts go by email to the **live recipients of the active subscriptions** (plus any `ALERT_EMAIL` addresses)
**Auth model:** API key
**Env:** `RESEND_API_KEY`, `RESEND_FROM`, `ALERT_EMAIL` (optional extra alert recipients)
**Note:** digests (Beady opportunity, Cleo award), all operational alerts, and Patch's ticket/staff-request/inbound-triage notifications go over email. Microsoft Teams is no longer an outbound channel at all.

---

## Microsoft Teams (retired)
Both Teams surfaces were removed. The bot (`POST /api/teams/bot`) never worked: the app
was never installed in the tenant, so `conversations.external_id` is null on all 881 rows
(#162, #165). The one-way notifications used Office 365 Connectors, which Microsoft
retired in the 18-22 May 2026 rollout, so they had been silently dead since. Patch's
notifications moved to email. Microsoft Graph, SharePoint and Excel are unaffected and
remain in use.

---

## Apollo.io
**Used by:** Angie, for candidate sourcing (`angie/candidate-sourcing`)
**Integration code:** `integrations/apollo/` (`people-search.ts`, `base.ts`)
**Usage:** people search (titles, keywords, locations) → LLM scoring → human approval gate
**Auth model:** API key
**Env:** `APOLLO_API_KEY`

---

## Jira (Atlassian Cloud)
**Used by:** Patch, for ticket ops (`patch/ticket-ops`, `patch/staff-request`)
**Integration code:** `integrations/jira/` (`issues.ts`, `base.ts`)
**Usage:** create / update / search issues
**Auth model:** API token + account email
**Env:** `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_BASE_URL`

---

## GitHub
**Used by:** Patch, for Obsidian vault sync into the RAG knowledge base (`patch/vault-sync`)
**Integration code:** `integrations/github/` (`files.ts`, `base.ts`)
**Usage:** read repo file trees / contents (blob SHAs detect unchanged files); triggered by a signed GitHub webhook
**Auth model:** personal access token / GitHub App
**Env:** `GITHUB_API_TOKEN`, `GITHUB_WEBHOOK_SECRET` (signed webhook verification)

---

## Cloudflare Workers AI (embeddings)
**Used by:** document RAG (`document-rag.ts`), vault sync (`vault-sync.ts`), and agent memory (`memory.ts`)
**Usage:** `@cf/baai/bge-large-en-v1.5` (1024-dim) embeddings for pgvector retrieval (ivfflat, cosine)
**Auth model:** bound automatically to the Worker (no key)
**Env:** none (Workers AI binding)

---

## Cloudflare Workers / Workflows
**Used by:** the runtime itself (durable orchestration execution)
**Account:** `arun.rajendra@lumiture.com` (Account ID: `6ddb39faef7414bddd0c0993e293f895`)
**Auth:** OAuth via `wrangler login`
**Environments:** production (root config) + `[env.dev]`; separate KV namespaces per env

---

## Credential storage (Workers)

All runtime secrets are set via `wrangler secret put <name>`, never in `wrangler.toml` or committed files.

| Secret / var | Env name | Used by |
|--------------|----------|---------|
| Anthropic API key | `ANTHROPIC_API_KEY` | All LLM calls |
| Supabase URL | `SUPABASE_URL` | Runtime DB |
| Supabase service role key | `SUPABASE_SERVICE_ROLE_KEY` | Runtime DB writes |
| Supabase JWT secret | `SUPABASE_JWT_SECRET` | JWT verification |
| SAM.gov API key | `SAM_GOV_API_KEY` | Beady opportunity + industry-day sweeps, RFI attachments |
| SBIR base override | `SBIR_API_BASE` | Beady SBIR topic search (optional) |
| Tavily API key | `TAVILY_API_KEY` | Award + industry-day sweeps, GovCon D3 |
| Resend API key | `RESEND_API_KEY` | Digests + alerts |
| Resend from address | `RESEND_FROM` | Verified sender / per-agent `from` domain |
| Alert extra recipients | `ALERT_EMAIL` | Optional extra alert recipients |
| Apollo API key | `APOLLO_API_KEY` | Angie candidate sourcing |
| Jira email | `JIRA_EMAIL` | Patch tickets |
| Jira API token | `JIRA_API_TOKEN` | Patch tickets |
| Jira base URL | `JIRA_BASE_URL` | Patch tickets |
| GitHub token | `GITHUB_API_TOKEN` | Patch vault sync |
| GitHub webhook secret | `GITHUB_WEBHOOK_SECRET` | Signed vault-sync webhook |
