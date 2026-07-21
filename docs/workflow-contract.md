# Workflow contract

Every orchestration is a typed workflow. This document defines the shape. Follow it exactly; the runtime, dashboard, and tools all depend on this contract.

## An orchestration is a folder

```
/orchestrations/<name>/
  definition.ts      # the workflow itself
  tools.ts           # tools this workflow uses (re-exported from /integrations)
  prompts/           # prompt files for llm_decide / llm_extract
  tests/
  README.md          # what this orchestration does, who triggers it, who can see it
```

## `definition.ts` shape

```ts
import { z } from "zod";
import { defineOrchestration, step, llm_decide, llm_extract } from "@/runtime";
import { createTicket, lookupCustomer, sendEmail } from "./tools";

export const inputSchema = z.object({
  customerEmail: z.string().email(),
  message: z.string().min(1),
});

export const outputSchema = z.object({
  ticketId: z.string(),
  resolution: z.enum(["auto-resolved", "escalated", "needs-info"]),
});

export default defineOrchestration({
  name: "support-triage",
  version: 1,
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:support"],   // who can start a run
    visibleTo: ["role:support", "role:ops"], // who can see it in the dashboard
  },
  async run(ctx, input) {
    const customer = await step("lookup", () =>
      lookupCustomer(ctx, { email: input.customerEmail })
    );

    const category = await llm_decide(ctx, {
      promptFile: "prompts/categorize.md",
      input: { message: input.message, customer },
      options: ["billing", "technical", "account", "other"],
    });

    if (category === "billing") {
      const ticket = await step("create-billing-ticket", () =>
        createTicket(ctx, { ...input, category, priority: "high" })
      );
      await step("notify", () =>
        sendEmail(ctx, { to: input.customerEmail, template: "ticket-received", ticketId: ticket.id })
      );
      return { ticketId: ticket.id, resolution: "escalated" };
    }

    // ... etc
  },
});
```

Read that example before writing a new orchestration. The pattern is what matters more than the specifics.

## The runtime gives you four primitives

### `step(name, fn)`

Wraps a deterministic operation. Logs to `run_steps` before and after. Retries with backoff on transient failure. Idempotent: re-runs of the same step in a resumed workflow return the previous result.

### `llm_decide(ctx, { promptFile, input, options })`

Asks the model to pick one of `options`. Returns the chosen option (typed). Logs prompt, response, and tokens to `run_steps`. Use this for routing decisions where the answer space is small and known.

### `llm_extract(ctx, { promptFile, input, schema })`

Asks the model to extract structured data matching `schema` (a zod schema). Returns the parsed object (typed). Use this for parameter extraction from messy input.

### `await_approval(ctx, { from, prompt, expiresIn })`

Pauses the workflow, creates an `approvals` row, and resumes when a human decides. Returns `{ approved: boolean, notes: string }`. The dashboard renders the approval inbox from these rows.

## Tools

A tool is a typed wrapper around a side-effect (n8n webhook, integration API, Supabase write, etc.). Each tool lives in `/integrations/<system>/<tool>.ts` and is re-exported from the orchestration's `tools.ts` for clarity.

Every tool:
- Takes `ctx` (the runtime context, which gives access to logging, secrets, and the user the run is acting on behalf of).
- Takes a typed input.
- Returns a typed output.
- Carries an idempotency key (or is provably idempotent).
- Wraps its underlying call so retries don't double-fire.

Example:

```ts
// /integrations/n8n/lookup-customer.ts
import { z } from "zod";
import { defineTool } from "@/runtime";

export const lookupCustomer = defineTool({
  name: "lookupCustomer",
  inputSchema: z.object({ email: z.string().email() }),
  outputSchema: z.object({
    customerId: z.string(),
    name: z.string(),
    tier: z.enum(["free", "pro", "enterprise"]),
  }),
  async run(ctx, input) {
    const idempotencyKey = ctx.idempotencyKey("lookup-customer", input.email);
    const res = await ctx.fetch("https://n8n.internal/webhook/lookup-customer", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    });
    return await res.json();
  },
});
```

## Triggers

An orchestration can be invoked by:

- **HTTP:** POST to `/api/orchestrations/<name>/run` with input. Used by the dashboard and external systems.
- **Cron:** declared in `definition.ts` as `cron: "0 9 * * *"`. The runtime invokes with no input (or a stubbed input).
- **Queue:** for high-volume async cases. Producer puts a message; runtime drains.
- **Another orchestration:** `await invoke("other-orchestration", { ... })`. Captured as a child run in the runs table.

## What "schema-driven forms" means in practice

The dashboard reads `inputSchema` for each orchestration and renders a form. zod has good metadata support, so use `.describe()` and `.meta()` to add UI hints (label, help text, widget type). Don't hand-build forms. If you can't render the form from the schema, the schema is wrong.

## Testing an orchestration

Every orchestration has tests in `/tests/`:

- **Unit:** mock the runtime context. Test pure logic: branches, error handling.
- **Integration:** run against a local Supabase + a fake n8n. Verify the run lands in `runs` with expected `run_steps`.
- **Eval (when relevant):** for orchestrations with `llm_decide` / `llm_extract`, a small eval set in `tests/eval/` with input → expected decision. Run on PRs that touch the prompt.

## Anti-patterns

- A workflow that calls `fetch` directly instead of going through a tool. (You lose idempotency, retries, and audit.)
- An `llm_decide` with more than ~6 options, or with options that aren't mutually exclusive. (If the choice is open-ended, use `llm_extract` with a structured schema instead.)
- A step that doesn't use the `step()` wrapper. (You skip the run_steps log; ops can't debug it.)
- A tool that reads or writes Supabase using the service role key from inside dashboard-reachable code. (Auth bypass.)
- A tool that mutates state without an idempotency key. (Workers retry; you'll get duplicates.)
