import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { createJiraIssue, addJiraComment, transitionJiraIssue, searchJiraIssues } from "./tools";
import { sendAlertEmail, subscriptionRecipients } from "../../../integrations/resend/alert";
import { senderFor } from "../../../integrations/resend/sender";

// ─── Schemas ──────────────────────────────────────────────────────────────────

/*
 * One orchestration, three operations, selected by `operation`:
 *
 *  create: parse a plain-language request, create a Jira ticket, email ops
 *  update: transition status and/or add a comment to an existing ticket
 *  search: run a JQL query and return structured results (useful for dashboards / reports)
 */

export const inputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    projectKey: z
      .string()
      .default("OPS")
      .describe("Jira project key: OPS for ops tickets, BD for BD, HR for recruiting"),
    requestText: z
      .string()
      .min(10)
      .describe("Plain-language description of the work to be done"),
    requestedBy: z.string().describe("Name or email of who is requesting this"),
    notify: z.boolean().default(true).describe("Email ops when the ticket is created"),
  }),
  z.object({
    operation: z.literal("update"),
    issueKey: z.string().describe("Ticket to update (e.g. OPS-42)"),
    newStatus: z
      .string()
      .optional()
      .describe("Transition name to apply (e.g. 'In Progress', 'Done', 'In Review')"),
    comment: z.string().optional().describe("Comment to add to the ticket"),
  }),
  z.object({
    operation: z.literal("search"),
    jql: z.string().describe("JQL query string (e.g. 'project=OPS AND status=Open AND priority=High')"),
    maxResults: z.number().int().min(1).max(50).default(20).describe("Max tickets to return from the search"),
  }),
]);

export const outputSchema = z.object({
  operation: z.enum(["create", "update", "search"]),
  // create / update
  issueKey: z.string().nullable(),
  issueUrl: z.string().nullable(),
  summary: z.string().nullable(),
  status: z.string().nullable(),
  // search
  searchTotal: z.number().nullable(),
  searchResults: z
    .array(
      z.object({
        issueKey: z.string(),
        summary: z.string(),
        status: z.string(),
        priority: z.string(),
        assignee: z.string().nullable(),
        url: z.string(),
        updated: z.string(),
      }),
    )
    .nullable(),
});

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "patch/ticket-ops",
  version: 1,
  // #127: deliberately NOT readOnly. `operation: "search"` is a pure JQL read, but
  // "create" and "update" create Jira issues, transition them, add comments and send
  // email. Read-only-ness is a property of the orchestration, not of one branch of
  // its input, so this may never run on the retrying inline path.
  description: "Create, update, or search Jira tickets for ops. Patch's primary ticketing interface",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    // ── CREATE ────────────────────────────────────────────────────────────────
    if (input.operation === "create") {
      // Step 1: Extract structured ticket fields from the plain-language request
      const ticketFields = await llm_extract(ctx, {
        name: "extract-ticket-fields",
        prompt: `
You are Patch, Lumiture's ops AI. Extract structured Jira ticket fields from the
plain-language request below.

Rules:
- summary: concise one-liner, max 100 chars, imperative tense ("Set up S3 bucket for…")
- description: expand the request with enough detail for a developer/ops engineer to act
- issueType: Task for most things; Bug only if something is broken; Story for new features
- priority: High if it blocks work or affects a client; Medium for normal requests; Low for nice-to-haves
- labels: lowercase, hyphenated (e.g. ["database", "infrastructure", "client-facing"])
- Do not use em dashes.
        `.trim(),
        input: {
          requestText: input.requestText,
          requestedBy: input.requestedBy,
          projectKey: input.projectKey,
        },
        schema: z.object({
          summary: z.string().max(255),
          description: z.string(),
          issueType: z.enum(["Task", "Bug", "Story"]),
          priority: z.enum(["Highest", "High", "Medium", "Low", "Lowest"]),
          labels: z.array(z.string()),
        }),
      });

      // Step 2: Create the Jira issue
      const ticket = await step(ctx, "create-jira-issue", () =>
        createJiraIssue(ctx, {
          projectKey: input.projectKey,
          summary: ticketFields.summary,
          description: `${ticketFields.description}\n\n---\nRequested by: ${input.requestedBy}`,
          issueType: ticketFields.issueType,
          priority: ticketFields.priority,
          labels: ticketFields.labels,
        }),
      );

      // Step 3: Notify ops by email (optional).
      //
      // This posted an Office 365 Connector card into a Teams channel until Microsoft
      // retired those connectors in the 18-22 May 2026 rollout, after which the webhook
      // delivered nothing. Email already reaches people here, so the card became the
      // plain-text note below rather than a new Power Automate webhook. Recipients are
      // the active digest subscribers plus ALERT_EMAIL; sendAlertEmail returns
      // { sent: false } instead of throwing when there is nobody to tell.
      if (input.notify) {
        await step(ctx, "notify-ops", async () => {
          const to = await subscriptionRecipients(ctx.env);
          const result = await sendAlertEmail(ctx.env, {
            to,
            subject: `🎫 New ticket ${ticket.issueKey}: ${ticketFields.summary}`,
            text:
              `${ticketFields.summary}\n\n` +
              `Priority: ${ticketFields.priority}\n` +
              `Type: ${ticketFields.issueType}\n` +
              `Requested by: ${input.requestedBy}\n` +
              `\nOpen in Jira: ${ticket.url}`,
            from: senderFor(ctx.env, "patch"),
          });
          return { sent: result.sent, recipients: to.length };
        });
      }

      return {
        operation: "create",
        issueKey: ticket.issueKey,
        issueUrl: ticket.url,
        summary: ticket.summary,
        status: ticket.status,
        searchTotal: null,
        searchResults: null,
      };
    }

    // ── UPDATE ────────────────────────────────────────────────────────────────
    if (input.operation === "update") {
      let lastStatus = "unchanged";

      if (input.newStatus) {
        const transitioned = await step(ctx, "transition-issue", () =>
          transitionJiraIssue(ctx, {
            issueKey: input.issueKey,
            transitionName: input.newStatus as string,
            ...(input.comment ? { comment: input.comment } : {}),
          }),
        );
        lastStatus = transitioned.transitionApplied;
      } else if (input.comment) {
        await step(ctx, "add-comment", () =>
          addJiraComment(ctx, {
            issueKey: input.issueKey,
            comment: input.comment as string,
          }),
        );
      }

      return {
        operation: "update",
        issueKey: input.issueKey,
        issueUrl: `${ctx.env.JIRA_BASE_URL}/browse/${input.issueKey}`,
        summary: null,
        status: lastStatus,
        searchTotal: null,
        searchResults: null,
      };
    }

    // ── SEARCH ────────────────────────────────────────────────────────────────
    const results = await step(ctx, "search-issues", () =>
      searchJiraIssues(ctx, {
        jql: input.jql,
        maxResults: input.maxResults,
      }),
    );

    return {
      operation: "search",
      issueKey: null,
      issueUrl: null,
      summary: null,
      status: null,
      searchTotal: results.total,
      searchResults: results.issues,
    };
  },
});
