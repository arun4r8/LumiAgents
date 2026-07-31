import type { AgentDefinition } from "../types";

export const beady: AgentDefinition = {
  slug: "beady",
  displayName: "Beady",
  systemPrompt: `You are Beady, Lumiture's GovCon intelligence assistant. You help with:
- Searching for upcoming opportunities by NAICS code, set-aside, or agency
- Evaluating government contract opportunities from SAM.gov or pasted solicitations
- Answering questions about past performance and competitive positioning
- Interpreting go/no-go assessments already run against opportunities
- Drafting Sources Sought / RFI responses for opportunities, grounded in Lumiture's profile and past performance

GovCon qualification assessments (5-dimensional scoring with RAG) run through the dedicated
assessment pipeline. Use search_all_opportunities to find new leads and discuss results already
in the database. When asked to respond to a Sources Sought / RFI, kick off draft_rfi and tell the
user the draft will appear on the RFI Drafts dashboard page (drafting runs in the background).
Be analytical and concise. Cite specific evaluation factors when making recommendations.
Do not use em dashes.`,
  tools: [
    {
      name: "assess_opportunity",
      description: "Run a full GovCon qualification assessment for an opportunity already in the database. Produces a 5-dimensional score, go/no-go recommendation, and executive memo. If the user attaches a solicitation PDF it will be forwarded to the pipeline automatically; only a single PDF is supported per assessment.",
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
      name: "draft_rfi",
      description:
        "Draft a Sources Sought / RFI response for an opportunity, grounded in Lumiture's profile and past performance. Runs in the background; the finished draft appears on the RFI Drafts dashboard page. Use when the user wants to respond to a Sources Sought / RFI.",
      inputSchema: {
        type: "object",
        properties: {
          samNoticeId: {
            type: "string",
            description: "The sam_notice_id of the opportunity to draft a response for (from the opportunity digest or dashboard).",
          },
        },
        required: ["samNoticeId"],
      },
    },
    {
      name: "find_industry_days",
      description:
        "Discover upcoming government agency industry days / vendor-outreach / small-business matchmaking events (SAM.gov Special Notices + web), scored for relevance to Lumiture. Runs in the background; results land on the Industry Days dashboard page. Use when the user wants to find events to attend.",
      inputSchema: {
        type: "object",
        properties: {
          minScore: { type: "number", description: "Minimum relevance score to keep (1-10, default 4)." },
          postedWithinDays: { type: "number", description: "SAM: notices posted in the last N days (default 90)." },
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
    {
      name: "search_all_opportunities",
      description: "Parallel sweep of SAM.gov AND DoD SBIR/STTR topics in one shot. Scores everything together and saves the shortlist. Prefer this over calling the two search tools separately.",
      inputSchema: {
        type: "object",
        properties: {
          keywords:        { type: "string", description: "Keywords applied to both sources" },
          naicsCodes:      { type: "array", items: { type: "string" }, description: "NAICS codes for SAM.gov filter (default: IT/engineering codes)" },
          agencies:        { type: "array", items: { type: "string" }, description: "Agency name filter for SAM.gov (e.g. ['Department of Defense'])" },
          sbirComponents:  { type: "array", items: { type: "string" }, description: "DoD branch filter for SBIR (e.g. ['ARMY', 'USAF']). Omit for all." },
          postedWithinDays:{ type: "number", description: "SAM.gov: only opportunities posted in the last N days (default 30)" },
          minScore:        { type: "number", description: "Min Beady fit score to include (1-10, default 5)" },
          samLimit:        { type: "number", description: "Max SAM.gov results (default 50)" },
          sbirLimit:       { type: "number", description: "Max SBIR results (default 50)" },
        },
      },
    },
    {
      name: "get_recent_opportunities",
      description:
        "Get opportunities the sweep has found/touched recently, ranked by fit score (e.g. 'top 3 contracts from today's sweep'). Reads existing results; does not run a new sweep.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max opportunities to return (default 10, max 50)" },
          sinceHours: { type: "number", description: "How far back to look, in hours (default 24)" },
        },
      },
    },
  ],
  toolMap: {
    assess_opportunity:      { orchestration: "beady/govcon-assessment" },
    draft_rfi:               { orchestration: "beady/rfi-draft" },
    find_industry_days:      { orchestration: "beady/industry-day-sweep" },
    seed_past_performance:   { orchestration: "beady/past-performance-seed" },
    search_all_opportunities: { orchestration: "beady/opportunity-sweep" },
    get_recent_opportunities: { orchestration: "beady/recent-opportunities", mode: "sync" },
  },
};
