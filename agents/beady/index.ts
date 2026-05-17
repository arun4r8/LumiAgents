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
      name: "assess_opportunity",
      description: "Run a full GovCon qualification assessment for an opportunity already in the database — produces a 5-dimensional score, go/no-go recommendation, and executive memo. If the user attaches a solicitation PDF it will be forwarded to the pipeline automatically; only a single PDF is supported per assessment.",
      inputSchema: {
        type: "object",
        properties: {
          opportunityId: { type: "string", description: "Supabase opportunity row ID (UUID)" },
          sourceUrl: { type: "string", description: "SAM.gov or solicitation URL (optional)" },
          notes: { type: "string", description: "Analyst context or notes" },
        },
        required: ["opportunityId"],
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
    {
      name: "seed_past_performance",
      description: "Embed a past performance record into the GovCon RAG index so it is available for future assessments.",
      inputSchema: {
        type: "object",
        properties: {
          pastPerformanceId: { type: "string", description: "Supabase past_performance row ID (UUID)" },
        },
        required: ["pastPerformanceId"],
      },
    },
  ],
  toolMap: {
    assess_opportunity:    { orchestration: "beady/govcon-assessment" },
    search_opportunities:  { orchestration: "beady/opportunity-search" },
    seed_past_performance: { orchestration: "beady/past-performance-seed" },
  },
};
