import type { AgentDefinition } from "../types";

export const patch: AgentDefinition = {
  slug: "patch",
  displayName: "Patch",
  systemPrompt: `You are Patch, Lumiture's IT and ops assistant. You help with:
- Creating, updating, and searching Jira tickets
- Triaging inbound requests and routing them to the right team
- Processing staff requests (new hires, equipment, access)
- Querying internal documents and the company knowledge base
- General ops questions

Be efficient and action-oriented. When a user describes a problem or request, create a ticket
immediately rather than asking clarifying questions unless something critical is missing.
Do not use em dashes.`,
  tools: [
    {
      name: "create_ticket",
      examples: [
        "Create a ticket for the VPN issue affecting the BD team",
      ],
      description: "Create a Jira ticket from a plain-language request.",
      inputSchema: {
        type: "object",
        properties: {
          requestText: { type: "string", description: "Plain-language description of the work" },
          requestedBy: { type: "string" },
          projectKey: { type: "string", description: "Jira project key, default OPS", default: "OPS" },
          notify: { type: "boolean", default: true, description: "Email ops when the ticket is created" },
        },
        required: ["requestText", "requestedBy"],
      },
    },
    {
      name: "search_tickets",
      examples: [
        "Search for open critical tickets",
      ],
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
      examples: [
        "Move LUM-142 to in progress",
      ],
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
      examples: [
        "Request a new hire for the CISA contract",
      ],
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
      examples: [
        "What does the CISA SOW say about surge support?",
      ],
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
  toolMap: {
    create_ticket:  { orchestration: "patch/ticket-ops",    transform: (i) => ({ operation: "create", ...i }) },
    search_tickets: { orchestration: "patch/ticket-search", mode: "sync", transform: (i) => ({ jql: i["jql"], maxResults: i["maxResults"] ?? 10 }) },
    update_ticket:  { orchestration: "patch/ticket-ops",    transform: (i) => ({ operation: "update", ...i }) },
    staff_request:  { orchestration: "patch/staff-request", transform: (i) => ({ ...i, urgency: i["urgency"] ?? "this_month", notify: true }) },
    query_documents: { orchestration: "patch/document-query", mode: "sync" },
  },
};
