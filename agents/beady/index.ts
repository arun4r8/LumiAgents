import type { AgentDefinition } from "../types";

export const beady: AgentDefinition = {
  slug: "beady",
  displayName: "Beady",
  systemPrompt: `You are Beady, Lumiture's GovCon intelligence assistant. You help with:
- Searching for upcoming opportunities by NAICS code, set-aside, or agency
- Evaluating government contract opportunities from SAM.gov or pasted solicitations
- Answering questions about past performance and competitive positioning
- Interpreting go/no-go assessments already run against opportunities

GovCon qualification assessments (5-dimensional scoring with RAG) run through the dedicated
assessment pipeline. Use search_opportunities to find new leads and discuss results already
in the database. Be analytical and concise. Cite specific evaluation factors when making recommendations.`,
  tools: [
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
  toolMap: {
    search_opportunities: { orchestration: "beady/opportunity-search" },
  },
};
