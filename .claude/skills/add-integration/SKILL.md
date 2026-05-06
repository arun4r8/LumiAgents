---
name: add-integration
description: Use when the user wants to add a new tool to /integrations/ — wrapping an n8n webhook, an external API, or any side-effect that orchestrations will call. Trigger on phrases like "add an integration", "wrap the n8n flow", "expose X as a tool", "I need to call Y from a workflow".
---

# Adding a new integration / tool

A tool is a typed, idempotent wrapper around a side effect. Orchestrations only ever call side effects through tools.

## Before writing

Confirm with the user:
- What's the underlying call? (n8n webhook URL, external API endpoint, internal service)
- Auth model? (bearer token, OAuth, signed webhook, none)
- Is it naturally idempotent? If not, what fields make a request unique?
- What's the rate limit? Retry policy?
- Does the response need normalization, or do we pass it through?

## Folder structure

```
/integrations/<system>/
  <tool-name>.ts        # one tool per file
  client.ts             # shared HTTP client for the system, if more than one tool
  types.ts              # shared types
  README.md             # auth setup, rate limits, how to test against sandbox
```

`<system>` is the underlying system (`n8n`, `salesforce`, `slack`, etc.), not the action. We bin tools by system so credentials, rate limiting, and shared types live in one place.

## The tool itself

Use `defineTool` from the runtime:

```ts
import { z } from "zod";
import { defineTool } from "@/runtime";

export const lookupCustomer = defineTool({
  name: "lookupCustomer",
  inputSchema: z.object({
    email: z.string().email(),
  }),
  outputSchema: z.object({
    customerId: z.string(),
    name: z.string(),
    tier: z.enum(["free", "pro", "enterprise"]),
  }),
  async run(ctx, input) {
    const idempotencyKey = ctx.idempotencyKey("lookup-customer", input.email);
    const res = await ctx.fetch(URL, {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "Authorization": `Bearer ${await ctx.secret("N8N_TOKEN")}`,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`lookupCustomer failed: ${res.status}`);
    return outputSchema.parse(await res.json());
  },
});
```

Always:
- Validate the response with the output schema before returning. Don't trust upstream.
- Use `ctx.fetch` (logs to `tool_calls` automatically), not raw `fetch`.
- Use `ctx.secret(name)` for credentials. No env reads in tool code.
- Use `ctx.idempotencyKey(toolName, ...keyFields)` and pass it as a header (or include it in the request body if the upstream expects that).

## Idempotency

If the underlying system supports an `Idempotency-Key` header, use it. If it doesn't:
- For reads: idempotency is automatic.
- For writes that have a natural unique key (e.g., "create ticket with external_ref X"): include the unique key in the request, and ensure the upstream rejects duplicates.
- For writes with no natural key: write a small dedupe layer in `client.ts` that records "we already did key K" in Supabase before calling upstream. Discuss with the user before doing this — it's the heaviest pattern.

## Tests

- `unit.test.ts` — mock `ctx.fetch`. Verify request shape (headers, body, idempotency key) and response parsing.
- `integration.test.ts` (when there's a sandbox) — hit a real sandbox endpoint. Skipped in CI unless `SANDBOX_CREDENTIALS` is set.

## README

`/integrations/<system>/README.md`:
- How to set up credentials locally.
- Sandbox vs. production endpoints.
- Rate limits and current handling.
- Quirks — especially anything where the upstream's behavior surprised us.

## Gotchas

- n8n webhooks are not idempotent by default. Always include an idempotency key in the body and have n8n's flow check it before doing work.
- Workers have no Node-only modules. If the SDK you'd reach for is Node-only, write a thin fetch wrapper instead.
- Don't import an integration from another integration. If two tools need the same thing, factor it into `client.ts` or a util.
- Don't write to Supabase from tools using the service role unless the tool is explicitly a "system action" (e.g., recording an artifact). Most tools should be pure outbound calls.
