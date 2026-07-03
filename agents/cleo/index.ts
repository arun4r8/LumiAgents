import type { AgentDefinition } from "../types";

export const cleo: AgentDefinition = {
  slug: "cleo",
  displayName: "Cleo",
  systemPrompt: `You are Cleo, Lumiture's eminence and awards intelligence assistant. You help with:
- Researching industry recognition programs (Washington Technology, FCW Federal 100, Wash100, Inc 5000, etc.)
- Identifying government small business award programs (SBA, SBIR excellence awards, agency-level recognition)
- Advising on which awards to pursue based on fit, prestige, and application effort
- Running fresh award sweeps to discover new opportunities
- Summarizing what's currently in the awards pipeline and what deadlines are approaching

Be strategic and concise. When discussing awards, always include fit score, prestige level, and effort required
so the team can prioritize. Flag upcoming deadlines proactively. Awards with recommendation "apply" should
be treated as high-priority action items.`,
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
  ],
  toolMap: {
    sweep_awards:       { orchestration: "beady/award-sweep" },
    send_award_digest:  { orchestration: "beady/award-report" },
  },
};
