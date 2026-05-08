/**
 * Agent chat loop — a Claude agent loop that calls orchestrations as tools.
 *
 * Each "agent" (Angie, Beady, Patch, Money) has:
 *   - A system prompt describing its domain and personality
 *   - A set of tools (orchestration runners it can trigger)
 *   - Access to file context (PDFs, CSVs, text files passed by the user)
 *
 * The loop runs synchronously for up to MAX_TOOL_ROUNDS rounds, returning
 * the final assistant text plus any run IDs that were triggered.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../types";

const MODEL = "claude-sonnet-4-6";
const MAX_TOOL_ROUNDS = 6;

// ─── Message types ────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface FileAttachment {
  name: string;
  /** MIME type, e.g. "text/plain", "application/pdf", "text/csv" */
  mimeType: string;
  /** Base64-encoded content (for images) or raw text (for text/csv/code). */
  content: string;
}

export interface AgentChatRequest {
  agentSlug: "angie" | "beady" | "patch" | "money";
  /** Full conversation history (including the new user message at the end). */
  messages: ChatMessage[];
  /** File attachments for the latest user turn. */
  files?: FileAttachment[];
}

export interface AgentChatResponse {
  reply: string;
  /** Orchestration run IDs triggered during this turn. */
  runIds: string[];
}

// ─── Agent configs ────────────────────────────────────────────────────────────

interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface AgentConfig {
  slug: string;
  displayName: string;
  systemPrompt: string;
  tools: AgentTool[];
}

const AGENTS: Record<string, AgentConfig> = {
  angie: {
    slug: "angie",
    displayName: "Angie",
    systemPrompt: `You are Angie, Lumiture's AI recruiting and HR assistant. You help with:
- Screening resumes against job requirements
- Formatting resumes to the company standard template
- Sourcing candidates from Apollo
- Answering questions about hiring pipelines and candidate status

When users share a resume (as a file or pasted text), proactively offer to screen or format it.
Be concise and professional. When you trigger an orchestration, tell the user what you started and link them to the run.`,
    tools: [
      {
        name: "screen_resume",
        description: "Screen a resume against a job description — produces a score, recommendation, and structured candidate profile.",
        inputSchema: {
          type: "object",
          properties: {
            resumeText: { type: "string", description: "Full resume text" },
            jobDescription: { type: "string", description: "Job description or requirements" },
            candidateName: { type: "string", description: "Candidate name if known" },
          },
          required: ["resumeText", "jobDescription"],
        },
      },
      {
        name: "format_resume",
        description: "Format a resume to the Lumiture standard template.",
        inputSchema: {
          type: "object",
          properties: {
            resumeText: { type: "string", description: "Raw resume text to format" },
            candidateName: { type: "string", description: "Candidate name" },
          },
          required: ["resumeText"],
        },
      },
      {
        name: "source_candidates",
        description: "Search Apollo for candidates matching a role.",
        inputSchema: {
          type: "object",
          properties: {
            jobTitle: { type: "string" },
            skills: { type: "array", items: { type: "string" } },
            location: { type: "string" },
            clearanceRequired: { type: "boolean" },
          },
          required: ["jobTitle"],
        },
      },
    ],
  },

  beady: {
    slug: "beady",
    displayName: "Beady",
    systemPrompt: `You are Beady, Lumiture's GovCon intelligence assistant. You help with:
- Evaluating government contract opportunities from SAM.gov or pasted solicitations
- Producing go/no-go assessments with an exec summary memo
- Searching for upcoming opportunities by NAICS code, set-aside, or agency
- Answering questions about past performance and competitive positioning

When users share a solicitation or opportunity description, offer to run a full assessment.
Be analytical and concise. Cite specific evaluation factors when making recommendations.`,
    tools: [
      {
        name: "assess_opportunity",
        description: "Run a full GovCon go/no-go assessment for a contract opportunity — produces a score, recommendation, and exec memo.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Opportunity title or solicitation number" },
            description: { type: "string", description: "Full solicitation text or description" },
            agency: { type: "string" },
            naicsCode: { type: "string" },
            dueDate: { type: "string" },
            estimatedValue: { type: "string" },
          },
          required: ["title", "description"],
        },
      },
      {
        name: "search_opportunities",
        description: "Search SAM.gov for active contract opportunities.",
        inputSchema: {
          type: "object",
          properties: {
            naicsCode: { type: "string" },
            keywords: { type: "string" },
            setAside: { type: "string", description: "e.g. 8(a), SDVOSB, WOSB" },
            agency: { type: "string" },
            daysAhead: { type: "number", description: "Opportunities closing within N days" },
          },
        },
      },
    ],
  },

  patch: {
    slug: "patch",
    displayName: "Patch",
    systemPrompt: `You are Patch, Lumiture's IT and ops assistant. You help with:
- Creating, updating, and searching Jira tickets
- Triaging inbound requests and routing them to the right team
- Processing staff requests (new hires, equipment, access)
- Querying internal documents
- General ops questions

Be efficient and action-oriented. When a user describes a problem or request, create a ticket immediately rather than asking clarifying questions unless something critical is missing.`,
    tools: [
      {
        name: "create_ticket",
        description: "Create a Jira ticket from a plain-language request.",
        inputSchema: {
          type: "object",
          properties: {
            requestText: { type: "string", description: "Plain-language description of the work" },
            requestedBy: { type: "string" },
            projectKey: { type: "string", description: "Jira project key, default OPS", default: "OPS" },
            notifyTeams: { type: "boolean", default: true },
          },
          required: ["requestText", "requestedBy"],
        },
      },
      {
        name: "search_tickets",
        description: "Search Jira tickets with a JQL query.",
        inputSchema: {
          type: "object",
          properties: {
            jql: { type: "string", description: "JQL query, e.g. 'project=OPS AND status=Open'" },
            maxResults: { type: "number", default: 10 },
          },
          required: ["jql"],
        },
      },
      {
        name: "update_ticket",
        description: "Transition or comment on an existing Jira ticket.",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: { type: "string" },
            newStatus: { type: "string", description: "e.g. 'In Progress', 'Done'" },
            comment: { type: "string" },
          },
          required: ["issueKey"],
        },
      },
      {
        name: "staff_request",
        description: "Log a staff request (new hire, equipment, access, etc.) and create an HR Jira ticket.",
        inputSchema: {
          type: "object",
          properties: {
            requestType: {
              type: "string",
              enum: ["new_hire", "backfill", "contractor", "equipment", "access", "general"],
            },
            requestText: { type: "string" },
            requestedBy: { type: "string" },
            urgency: { type: "string", enum: ["immediate", "this_week", "this_month", "no_rush"] },
          },
          required: ["requestType", "requestText", "requestedBy"],
        },
      },
      {
        name: "query_documents",
        description: "Search the internal document knowledge base.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string" },
          },
          required: ["question"],
        },
      },
    ],
  },

  money: {
    slug: "money",
    displayName: "Money",
    systemPrompt: `You are Money, Lumiture's financial intelligence assistant. You help with:
- Analyzing financial data (contracts, invoices, labor, indirect rates)
- Generating financial reports and summaries
- Answering questions about budget burn, revenue, and profitability
- Running ad-hoc SQL queries against the financial database
- Interpreting uploaded CSVs or spreadsheet exports

When users share financial data or ask about numbers, be precise and cite your sources.
Proactively surface anomalies or trends you notice.`,
    tools: [
      {
        name: "generate_financial_report",
        description: "Generate a structured financial report for a date range.",
        inputSchema: {
          type: "object",
          properties: {
            reportType: {
              type: "string",
              enum: ["summary", "revenue", "costs", "indirect_rates", "contract_burn"],
            },
            startDate: { type: "string", description: "ISO date, e.g. 2025-01-01" },
            endDate: { type: "string", description: "ISO date, e.g. 2025-03-31" },
            contractIds: {
              type: "array",
              items: { type: "string" },
              description: "Filter to specific contracts (optional)",
            },
          },
          required: ["reportType", "startDate", "endDate"],
        },
      },
      {
        name: "query_data",
        description: "Run a natural-language query against the financial database.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "Plain English question about financial data" },
          },
          required: ["question"],
        },
      },
    ],
  },
};

// ─── Tool → orchestration mapping ─────────────────────────────────────────────

type ToolInput = Record<string, unknown>;

async function dispatchTool(
  toolName: string,
  toolInput: ToolInput,
  agentSlug: string,
  env: Env,
  runtimeUrl: string,
): Promise<{ result: unknown; runId?: string }> {
  // Map tool names to orchestration names + transform inputs
  const orchMap: Record<string, { name: string; transform?: (i: ToolInput) => ToolInput }> = {
    screen_resume:     { name: "angie/resume-screening",  transform: (i) => ({ resumeText: i["resumeText"], jobDescription: i["jobDescription"], candidateName: i["candidateName"] }) },
    format_resume:     { name: "angie/resume-formatting", transform: (i) => ({ resumeText: i["resumeText"], candidateName: i["candidateName"] }) },
    source_candidates: { name: "angie/candidate-sourcing" },
    assess_opportunity:{ name: "beady/govcon-assessment" },
    search_opportunities: { name: "beady/opportunity-search" },
    create_ticket:     { name: "patch/ticket-ops",    transform: (i) => ({ operation: "create", ...i }) },
    search_tickets:    { name: "patch/ticket-ops",    transform: (i) => ({ operation: "search", jql: i["jql"], maxResults: i["maxResults"] ?? 10 }) },
    update_ticket:     { name: "patch/ticket-ops",    transform: (i) => ({ operation: "update", ...i }) },
    staff_request:     { name: "patch/staff-request", transform: (i) => ({ ...i, urgency: i["urgency"] ?? "this_month", notifyTeams: true }) },
    query_documents:   { name: "patch/document-query" },
    generate_financial_report: { name: "money/financial-report" },
    query_data: {
      name: "money/financial-report",
      // For natural language queries, fall through to the data analyst
      transform: (i) => i,
    },
  };

  const mapping = orchMap[toolName];
  if (!mapping) {
    return { result: { error: `Unknown tool: ${toolName}` } };
  }

  const payload = mapping.transform ? mapping.transform(toolInput) : toolInput;

  // Dispatch to the orchestration endpoint
  const resp = await fetch(`${runtimeUrl}/api/orchestrations/${encodeURIComponent(mapping.name)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = (await resp.json()) as { runId?: string; output?: unknown; error?: string };

  if (!resp.ok) {
    return { result: { error: data.error ?? `HTTP ${resp.status}` } };
  }

  return {
    ...(data.runId !== undefined && { runId: data.runId }),
    result: {
      runId: data.runId ?? null,
      status: "started",
      message: `Orchestration started. Run ID: ${data.runId}`,
      output: data.output ?? null,
    },
  };
}

// ─── Main chat loop ───────────────────────────────────────────────────────────

export async function runAgentChat(
  env: Env,
  request: AgentChatRequest,
  /** Base URL of this Worker (for self-calls to /api/orchestrations/). */
  runtimeUrl: string,
): Promise<AgentChatResponse> {
  const config = AGENTS[request.agentSlug];
  if (!config) throw new Error(`Unknown agent slug: ${request.agentSlug}`);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const runIds: string[] = [];

  // Build the messages array, injecting file content into the last user turn
  const messages: Anthropic.MessageParam[] = request.messages.map((m, i) => {
    const isLast = i === request.messages.length - 1;
    if (isLast && m.role === "user" && request.files?.length) {
      // Append file contents to the last user message
      const fileContextParts: Anthropic.TextBlockParam[] = request.files.map((f) => ({
        type: "text",
        text: `\n\n---\n**File: ${f.name}** (${f.mimeType})\n\`\`\`\n${f.content}\n\`\`\``,
      }));

      return {
        role: "user",
        content: [
          { type: "text", text: m.content },
          ...fileContextParts,
        ],
      };
    }
    return { role: m.role, content: m.content };
  });

  // Tool-use loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: config.systemPrompt,
      tools: config.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
      })),
      messages,
    });

    // If model is done, return the text
    if (response.stop_reason === "end_turn") {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { reply: text, runIds };
    }

    // Handle tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      // No tool calls and not end_turn — take whatever text we have
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { reply: text || "Done.", runIds };
    }

    // Add assistant turn with tool calls
    messages.push({ role: "assistant", content: response.content });

    // Execute all tool calls and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const { result, runId } = await dispatchTool(
          block.name,
          block.input as ToolInput,
          request.agentSlug,
          env,
          runtimeUrl,
        );
        if (runId) runIds.push(runId);

        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      }),
    );

    messages.push({ role: "user", content: toolResults });
  }

  return {
    reply: "I've completed the requested actions. Check the run links above for details.",
    runIds,
  };
}
