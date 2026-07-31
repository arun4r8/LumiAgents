import type { AgentDefinition } from "../types";

export const cleo: AgentDefinition = {
  slug: "cleo",
  displayName: "Cleo",
  systemPrompt: `You are Cleo, Lumiture's eminence, awards, and proposal-writing assistant. You help with:
- Researching industry recognition programs (Washington Technology, FCW Federal 100, Wash100, Inc 5000, etc.)
- Identifying government small business award programs (SBA, SBIR excellence awards, agency-level recognition)
- Advising on which awards to pursue based on fit, prestige, and application effort
- Running fresh award sweeps to discover new opportunities
- Summarizing what's currently in the awards pipeline and what deadlines are approaching
- Planning and drafting the eminence content calendar (LinkedIn posts): proposing ideas and drafting post copy + asset briefs

Be strategic and concise. When discussing awards, always include fit score, prestige level, and effort required
so the team can prioritize. Flag upcoming deadlines proactively. Awards with recommendation "apply" should
be treated as high-priority action items. For content, use plan_calendar to seed ideas from a theme and
draft_content to draft a specific calendar entry; drafts land on the Content Calendar dashboard page and a
human always reviews before posting.
Do not use em dashes.`,
  tools: [
    {
      name: "sweep_awards",
      description:
        "Run a fresh Tavily sweep for industry recognition awards and government small business award programs. Scores each on fit, prestige, and application effort, then saves the shortlist. Use this when the user wants to discover new awards or refresh the current list.",
      inputSchema: {
        type: "object",
        properties: {
          includeIndustry: {
            type: "boolean",
            description: "Include industry recognition awards (Washington Technology, FCW Federal 100, Wash100, Inc 5000, etc.). Default true.",
          },
          includeGovernment: {
            type: "boolean",
            description: "Include government small business award programs (SBA, SBIR excellence, agency awards). Default true.",
          },
          minScore: {
            type: "number",
            description: "Minimum fit score to save (1-10). Default 5.",
          },
        },
      },
    },
    {
      name: "send_award_digest",
      description:
        "Send the current award digest email to a specific subscription immediately, bypassing the normal cadence. Use this when the user wants to push the latest awards to a recipient right now.",
      inputSchema: {
        type: "object",
        properties: {
          subscriptionId: {
            type: "string",
            description: "UUID of the award_subscription to send to.",
          },
        },
        required: ["subscriptionId"],
      },
    },
    {
      name: "plan_calendar",
      description:
        "Propose a run of content-calendar post ideas from a theme and add them as idea rows (weekly cadence) for the team to review. Use when the user wants to fill out the eminence calendar.",
      inputSchema: {
        type: "object",
        properties: {
          theme: { type: "string", description: "The theme or campaign to generate post ideas around." },
          count: { type: "number", description: "How many ideas to generate (default 5)." },
          startDate: { type: "string", description: "ISO date to start scheduling from (default today)." },
        },
        required: ["theme"],
      },
    },
    {
      name: "draft_content",
      description:
        "Draft a LinkedIn eminence post (copy + asset brief) for a specific content-calendar entry, grounded in the company profile. Runs in the background; the draft appears on the Content Calendar dashboard page with status 'ready'.",
      inputSchema: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "The content_calendar.id of the entry to draft a post for." },
        },
        required: ["calendarId"],
      },
    },
    {
      name: "get_recent_awards",
      description:
        "Get awards the sweep has found/touched recently, ranked by fit score (e.g. 'what have you found in the awards pipeline'). Reads existing results; does not run a new sweep.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max awards to return (default 10, max 50)" },
          sinceHours: { type: "number", description: "How far back to look, in hours (default 24)" },
        },
      },
    },
    {
      name: "get_recent_content",
      description:
        "Get content-calendar items updated recently (e.g. 'what have you drafted today'). Reads existing entries; does not draft anything new.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max items to return (default 10, max 50)" },
          sinceHours: { type: "number", description: "How far back to look, in hours (default 24)" },
        },
      },
    },
  ],
  toolMap: {
    sweep_awards:       { orchestration: "cleo/award-sweep" },
    send_award_digest:  { orchestration: "cleo/award-report" },
    plan_calendar:      { orchestration: "cleo/content-plan" },
    draft_content:      { orchestration: "cleo/content-draft" },
    get_recent_awards:  { orchestration: "cleo/recent-awards", mode: "sync" },
    get_recent_content: { orchestration: "cleo/recent-content", mode: "sync" },
  },
};
