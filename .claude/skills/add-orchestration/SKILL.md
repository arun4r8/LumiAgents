---
name: add-orchestration
description: Use when the user wants to add a new orchestration to /orchestrations/. Covers the folder structure, definition.ts shape, tool wiring, prompt files, tests, and dashboard registration. Trigger on phrases like "add an orchestration", "new workflow", "scaffold a flow", or any request to wire a new multi-step process.
---

# Adding a new orchestration

## Before scaffolding

Ask the user (or check `docs/orchestrations-target.md`) for:
- What does this orchestration do, in one sentence?
- What's the input? Be specific: fields and types.
- What's the output?
- Who triggers it (role)? Who can see runs (role)?
- Which existing tools does it use? Which new ones does it need?
- Are there decision points? If so, are they routing (small fixed option set → `llm_decide`) or extraction (structured data from messy input → `llm_extract`)?

If any of these answers is fuzzy, write them down clearly with the user before touching code. Most orchestration bugs come from fuzzy specs, not bad code.

## Step 1: clone the closest existing orchestration

Run `ls /orchestrations/` and pick the one closest in shape (similar trigger, similar tool mix). Copy the folder. Rename. **Do not scaffold from a blank template**; the patterns drift if you do.

## Step 2: rewrite `definition.ts`

Follow `docs/workflow-contract.md`. The required pieces:
- `inputSchema` (zod): use `.describe()` on every field so the dashboard form has labels.
- `outputSchema` (zod).
- `access`: triggerableBy and visibleTo roles.
- `run(ctx, input)`: the workflow logic.

Every side effect goes through `step()` or a tool. No raw `fetch` calls.

## Step 3: wire tools in `tools.ts`

Re-export from `/integrations/`. If you need a tool that doesn't exist:
- Stop. Write the tool first as a separate change in `/integrations/<system>/`.
- Tools must follow the `defineTool` pattern with idempotency keys.

## Step 4: prompt files

For each `llm_decide` or `llm_extract`, write the prompt as a markdown file in `prompts/`. Reference it by `promptFile: "prompts/categorize.md"`.

The prompt file should:
- State the task in one sentence.
- Describe the input format.
- For `llm_decide`: list the options with a one-line rule each for when to pick each.
- For `llm_extract`: describe the schema in plain English alongside the formal schema.
- Include 2–3 worked examples.

## Step 5: tests

In `tests/`:
- `unit.test.ts`: mock the runtime context, test the branching logic. No real LLM, no real n8n.
- `integration.test.ts`: run against local Supabase + fake n8n. Verify a run lands correctly in `runs` / `run_steps`.
- For LLM steps: `tests/eval/cases.json` holds input → expected decision. The eval runner picks these up automatically.

## Step 6: README

`/orchestrations/<name>/README.md`:
- One-paragraph description.
- Trigger (HTTP / cron / queue / parent orchestration).
- Who triggers, who sees.
- Tools used.
- Known failure modes.

## Step 7: smoke test

Deploy to dev. Trigger via the dashboard with realistic input. Verify:
- The run appears in the runs list.
- Each step logs to `run_steps` with status transitions.
- The dashboard form was generated correctly from `inputSchema`.

Link the smoke run in the PR description.

## Gotchas

- Forgetting `access` makes the orchestration invisible to end users (it shows up to ops only). Not always a bug; sometimes intentional for ops-only flows.
- `llm_decide` with more than ~6 options is a smell. Either the options aren't mutually exclusive (use `llm_extract` instead) or the orchestration is doing too much (split it).
- A new tool added without an idempotency key will cause double-fires on Worker retry. Always add the key.
- Tests that import the real LLM client without mocking will burn tokens in CI. Mock at the runtime layer, not at the SDK layer.
