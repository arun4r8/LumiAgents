# govcon-assessment

Assesses a government contracting opportunity and produces a scored go/no-go recommendation with an executive memo.

## Who triggers it
Ops users via dashboard form, or via webhook from an external intake form.

## Who can see it
Ops role only.

## Input
- `opportunityId` (required) — UUID of the opportunity row in Supabase. The opportunity must be created before triggering this orchestration.
- `sourceUrl` (optional) — SAM.gov or solicitation URL for reference
- `notes` (optional) — Additional context

## Output
- `assessmentId` — UUID of the saved assessment row
- `score` — 0–100 qualification score
- `recommendation` — `go` | `no-go` | `conditional`
- `executiveMemo` — Full memo text
- `requiresReview` — If `true`, route to a human for review before committing

## What it does
1. Triggers the GovCon Assessment n8n workflow (`POST /govcon-assessment-intake`)
2. n8n handles: document extraction, vector similarity against capabilities + past performance, LLM scoring, memo generation, saving to Supabase
3. The orchestration layer adds: run logging, step-level observability, and an `llm_decide` call to determine if conditional recommendations need human review

## n8n workflows used
- `IgroV8Rw2NGJb3f6` — GovCon Qualification Assessment Workflows (active)

## Trigger
```bash
curl -X POST https://lumiagents-runtime.workers.dev/api/orchestrations/govcon-assessment/run \
  -H "Content-Type: application/json" \
  -d '{"opportunityId": "<uuid>", "sourceUrl": "https://sam.gov/..."}'
```
