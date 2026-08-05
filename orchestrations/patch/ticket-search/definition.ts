import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { searchJiraIssues } from "./tools";

/**
 * Read-only Jira search, split out of `patch/ticket-ops` (#127).
 *
 * Why this exists: `readOnly` is a property of an *orchestration*, not of one
 * branch of its input. `patch/ticket-ops` is a discriminated union whose
 * `create` and `update` branches write to Jira and post Teams cards, so it can
 * never be flagged `readOnly` and therefore may never run on the retrying
 * inline (`/run-sync`) path. But Patch's `search_tickets` tool genuinely is a
 * pure read, and it wants sync dispatch so results come back inside the
 * conversation instead of as a "run started" handle.
 *
 * So the search branch gets its own orchestration. `patch/ticket-ops` keeps its
 * three-operation union unchanged (nothing else that references it has to
 * move); the Patch agent simply points `search_tickets` here instead.
 */

export const inputSchema = z.object({
  jql: z
    .string()
    .describe(
      "Jira Query Language filter, e.g. \"project = OPS AND status = 'In Progress'\".",
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("How many issues to return (1-50)."),
});

export const outputSchema = z.object({
  searchTotal: z.number(),
  searchResults: z.array(
    z.object({
      issueKey: z.string(),
      summary: z.string(),
      status: z.string(),
      priority: z.string(),
      assignee: z.string().nullable(),
      url: z.string(),
      updated: z.string(),
    }),
  ),
});

export default defineOrchestration({
  name: "patch/ticket-search",
  version: 1,
  // Safe on the inline path: one JQL read against Jira, no writes, no
  // await_approval, no outbound notification.
  readOnly: true,
  description: "Search Jira tickets with JQL. Read-only companion to patch/ticket-ops.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const results = await step(ctx, "search-issues", () =>
      searchJiraIssues(ctx, { jql: input.jql, maxResults: input.maxResults }),
    );

    return {
      searchTotal: results.total,
      searchResults: results.issues,
    };
  },
});
