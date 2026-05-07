import { z } from "zod";
import { defineTool } from "../../runtime/src";
import { callJira } from "./base";

// ─── Shared sub-schemas ───────────────────────────────────────────────────────

const jiraIssueStubSchema = z.object({
  issueKey: z.string().describe("e.g. OPS-42"),
  issueId: z.string(),
  url: z.string().describe("Browser URL to the ticket"),
  summary: z.string(),
  status: z.string(),
});

// ─── createJiraIssue ──────────────────────────────────────────────────────────

export const createJiraIssue = defineTool({
  name: "createJiraIssue",
  inputSchema: z.object({
    projectKey: z.string().describe("Jira project key (e.g. 'OPS', 'BD', 'HR')"),
    summary: z.string().max(255),
    description: z.string().optional().describe("Full ticket body in plain text"),
    issueType: z
      .enum(["Task", "Bug", "Story", "Epic", "Sub-task"])
      .default("Task"),
    priority: z.enum(["Highest", "High", "Medium", "Low", "Lowest"]).default("Medium"),
    labels: z.array(z.string()).optional(),
    assigneeAccountId: z.string().optional().describe("Jira account ID of the assignee"),
    parentKey: z.string().optional().describe("Parent issue key for sub-tasks"),
  }),
  outputSchema: jiraIssueStubSchema,
  async run(ctx, input) {
    // Build the Jira issue fields payload (ADF for description)
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      summary: input.summary,
      issuetype: { name: input.issueType },
      priority: { name: input.priority },
    };

    if (input.description) {
      // Jira API v3 uses Atlassian Document Format (ADF) for description
      fields["description"] = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: input.description }],
          },
        ],
      };
    }

    if (input.labels && input.labels.length > 0) fields["labels"] = input.labels;
    if (input.assigneeAccountId) fields["assignee"] = { accountId: input.assigneeAccountId };
    if (input.parentKey) fields["parent"] = { key: input.parentKey };

    const res = await callJira<{ id: string; key: string; self: string }>(
      ctx,
      "POST",
      "/rest/api/3/issue",
      { fields },
    );

    return {
      issueKey: res.key,
      issueId: res.id,
      url: `${ctx.env.JIRA_BASE_URL}/browse/${res.key}`,
      summary: input.summary,
      status: "To Do",
    };
  },
});

// ─── getJiraIssue ─────────────────────────────────────────────────────────────

export const getJiraIssue = defineTool({
  name: "getJiraIssue",
  inputSchema: z.object({
    issueKey: z.string().describe("e.g. OPS-42"),
  }),
  outputSchema: z.object({
    issueKey: z.string(),
    issueId: z.string(),
    url: z.string(),
    summary: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    priority: z.string(),
    assignee: z.string().nullable(),
    reporter: z.string().nullable(),
    labels: z.array(z.string()),
    created: z.string(),
    updated: z.string(),
  }),
  async run(ctx, input) {
    const res = await callJira<{
      id: string;
      key: string;
      fields: {
        summary: string;
        description: { content?: Array<{ content?: Array<{ text?: string }> }> } | null;
        status: { name: string };
        priority: { name: string };
        assignee: { displayName: string } | null;
        reporter: { displayName: string } | null;
        labels: string[];
        created: string;
        updated: string;
      };
    }>(ctx, "GET", `/rest/api/3/issue/${input.issueKey}`);

    // Extract plain text from ADF description
    let description: string | null = null;
    if (res.fields.description) {
      const texts: string[] = [];
      for (const block of res.fields.description.content ?? []) {
        for (const inline of block.content ?? []) {
          if (inline.text) texts.push(inline.text);
        }
      }
      description = texts.join(" ") || null;
    }

    return {
      issueKey: res.key,
      issueId: res.id,
      url: `${ctx.env.JIRA_BASE_URL}/browse/${res.key}`,
      summary: res.fields.summary,
      description,
      status: res.fields.status.name,
      priority: res.fields.priority.name,
      assignee: res.fields.assignee?.displayName ?? null,
      reporter: res.fields.reporter?.displayName ?? null,
      labels: res.fields.labels,
      created: res.fields.created,
      updated: res.fields.updated,
    };
  },
});

// ─── addJiraComment ───────────────────────────────────────────────────────────

export const addJiraComment = defineTool({
  name: "addJiraComment",
  inputSchema: z.object({
    issueKey: z.string(),
    comment: z.string().min(1),
  }),
  outputSchema: z.object({
    commentId: z.string(),
    issueKey: z.string(),
    url: z.string(),
  }),
  async run(ctx, input) {
    const res = await callJira<{ id: string }>(
      ctx,
      "POST",
      `/rest/api/3/issue/${input.issueKey}/comment`,
      {
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: input.comment }],
            },
          ],
        },
      },
    );

    return {
      commentId: res.id,
      issueKey: input.issueKey,
      url: `${ctx.env.JIRA_BASE_URL}/browse/${input.issueKey}?focusedCommentId=${res.id}`,
    };
  },
});

// ─── transitionJiraIssue ──────────────────────────────────────────────────────

export const transitionJiraIssue = defineTool({
  name: "transitionJiraIssue",
  inputSchema: z.object({
    issueKey: z.string(),
    transitionName: z
      .string()
      .describe("Human-readable transition name (e.g. 'In Progress', 'Done', 'In Review'). We look it up."),
    comment: z.string().optional().describe("Optional comment to add with the transition"),
  }),
  outputSchema: z.object({
    issueKey: z.string(),
    transitionApplied: z.string(),
    url: z.string(),
  }),
  async run(ctx, input) {
    // Fetch available transitions
    const { transitions } = await callJira<{
      transitions: Array<{ id: string; name: string }>;
    }>(ctx, "GET", `/rest/api/3/issue/${input.issueKey}/transitions`);

    const target = transitions.find(
      (t) => t.name.toLowerCase() === input.transitionName.toLowerCase(),
    );

    if (!target) {
      const available = transitions.map((t) => t.name).join(", ");
      throw new Error(
        `Transition "${input.transitionName}" not found on ${input.issueKey}. Available: ${available}`,
      );
    }

    const body: Record<string, unknown> = { transition: { id: target.id } };
    if (input.comment) {
      body["update"] = {
        comment: [
          {
            add: {
              body: {
                type: "doc",
                version: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: input.comment }] }],
              },
            },
          },
        ],
      };
    }

    await callJira<Record<string, never>>(
      ctx,
      "POST",
      `/rest/api/3/issue/${input.issueKey}/transitions`,
      body,
    );

    return {
      issueKey: input.issueKey,
      transitionApplied: target.name,
      url: `${ctx.env.JIRA_BASE_URL}/browse/${input.issueKey}`,
    };
  },
});

// ─── searchJiraIssues ─────────────────────────────────────────────────────────

export const searchJiraIssues = defineTool({
  name: "searchJiraIssues",
  inputSchema: z.object({
    jql: z.string().describe("Jira Query Language expression (e.g. 'project=OPS AND status=Open')"),
    maxResults: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({
    total: z.number(),
    issues: z.array(
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
  }),
  async run(ctx, input) {
    const res = await callJira<{
      total: number;
      issues: Array<{
        key: string;
        fields: {
          summary: string;
          status: { name: string };
          priority: { name: string };
          assignee: { displayName: string } | null;
          updated: string;
        };
      }>;
    }>(ctx, "POST", "/rest/api/3/issue/search", {
      jql: input.jql,
      maxResults: input.maxResults,
      fields: ["summary", "status", "priority", "assignee", "updated"],
    });

    return {
      total: res.total,
      issues: res.issues.map((i) => ({
        issueKey: i.key,
        summary: i.fields.summary,
        status: i.fields.status.name,
        priority: i.fields.priority.name,
        assignee: i.fields.assignee?.displayName ?? null,
        url: `${ctx.env.JIRA_BASE_URL}/browse/${i.key}`,
        updated: i.fields.updated,
      })),
    };
  },
});
