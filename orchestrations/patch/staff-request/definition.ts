import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { createJiraIssue, sendTeamsCard } from "./tools";
import { sbHeaders } from "@/runtime/utils/supabase";

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const inputSchema = z.object({
  requestType: z
    .enum(["new_hire", "backfill", "contractor", "equipment", "access", "general"])
    .describe("Kind of request being raised"),
  requestText: z
    .string()
    .min(10)
    .describe("Plain-language description of the request"),
  requestedBy: z.string().describe("Name or email of the requester"),
  urgency: z
    .enum(["immediate", "this_week", "this_month", "no_rush"])
    .default("this_month")
    .describe("How soon the request needs to be actioned"),
  contractId: z
    .string()
    .uuid()
    .optional()
    .describe("Contract this request is associated with"),
  notifyTeams: z.boolean().default(true).describe("Post a Teams card when the request is filed"),
});

export const outputSchema = z.object({
  staffRequestId: z.string().describe("Supabase staff_requests row ID"),
  jiraKey: z.string().describe("Created Jira ticket key"),
  jiraUrl: z.string(),
  summary: z.string(),
  priority: z.string(),
});

// ─── Priority mapping ─────────────────────────────────────────────────────────

const URGENCY_TO_JIRA: Record<string, "Highest" | "High" | "Medium" | "Low" | "Lowest"> = {
  immediate: "Highest",
  this_week: "High",
  this_month: "Medium",
  no_rush: "Low",
};

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "patch/staff-request",
  version: 1,
  description:
    "Log a staff or operational request, create a Jira ticket in the HR project, and notify the team",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops", "role:hr"],
    visibleTo: ["role:ops", "role:hr"],
  },

  async run(ctx, input) {
    const jiraPriority = URGENCY_TO_JIRA[input.urgency] ?? "Medium";

    // Step 1: Extract structured fields from the plain-language request
    const fields = await llm_extract(ctx, {
      name: "extract-request-fields",
      prompt: `
You are Patch, Lumiture's ops AI. Extract structured fields for a staff or operational
request at a government contracting company.

requestType context:
  new_hire   → someone new needs to be hired
  backfill   → replacing a departing employee
  contractor → bringing in a temporary contractor
  equipment  → hardware, software licences, office gear
  access     → system access, VPN, credentials, clearance sponsorship
  general    → anything else

Output a concise Jira ticket summary (imperative, ≤ 100 chars) and a full description
with enough context for HR or ops to act without asking follow-up questions.
Labels should be lowercase, hyphenated, relevant (e.g. ["hiring", "cleared", "contract-support"]).
Do not use em dashes.
      `.trim(),
      input: {
        requestType: input.requestType,
        requestText: input.requestText,
        requestedBy: input.requestedBy,
        urgency: input.urgency,
        contractId: input.contractId ?? null,
      },
      schema: z.object({
        summary: z.string().max(100),
        description: z.string(),
        labels: z.array(z.string()),
      }),
    });

    // Step 2: Create Jira ticket in the HR project
    const ticket = await step(ctx, "create-jira-ticket", () =>
      createJiraIssue(ctx, {
        projectKey: "HR",
        summary: fields.summary,
        description: `${fields.description}\n\n---\nRequested by: ${input.requestedBy} | Urgency: ${input.urgency}${input.contractId ? ` | Contract: ${input.contractId}` : ""}`,
        issueType: "Task",
        priority: jiraPriority,
        labels: [input.requestType.replace("_", "-"), ...fields.labels],
      }),
    );

    // Step 3: Log to Supabase staff_requests table
    const staffRequestId = await step(ctx, "log-staff-request", async () => {
      const row = {
        title: fields.summary,
        request_type: input.requestType,
        description: fields.description,
        requested_by: input.requestedBy,
        priority: jiraPriority,
        jira_key: ticket.issueKey,
        jira_url: ticket.url,
        status: "open",
        source_run_id: ctx.runId,
        ...(input.contractId !== undefined ? { contract_id: input.contractId } : {}),
      };

      const res = await ctx.fetch(`${ctx.env.SUPABASE_URL}/rest/v1/staff_requests`, {
        method: "POST",
        headers: sbHeaders(ctx.env, { extra: { Prefer: "return=representation" } }),
        body: JSON.stringify(row),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase insert staff_request → ${res.status}: ${text}`);
      }

      const [created] = await res.json() as Array<{ id: string }>;
      return created?.id ?? "unknown";
    });

    // Step 4: Notify Teams
    if (input.notifyTeams) {
      await step(ctx, "notify-teams", () =>
        sendTeamsCard(ctx, {
          channel: "ops-general",
          title: `📋 Staff request: ${ticket.issueKey}`,
          body: `**${fields.summary}**\n\nRequested by: ${input.requestedBy} | Priority: ${jiraPriority} | Type: ${input.requestType.replace("_", " ")}`,
          actions: [{ label: "Open in Jira", url: ticket.url }],
        }),
      );
    }

    return {
      staffRequestId,
      jiraKey: ticket.issueKey,
      jiraUrl: ticket.url,
      summary: fields.summary,
      priority: jiraPriority,
    };
  },
});
