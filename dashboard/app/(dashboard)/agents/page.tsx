import Link from "next/link";

// ─── Agent metadata ───────────────────────────────────────────────────────────

export interface AgentMeta {
  slug: string;
  name: string;
  emoji: string;
  category: string;
  description: string;
  suggestedPrompts: string[];
}

export const AGENTS: AgentMeta[] = [
  {
    slug: "angie",
    name: "Angie",
    emoji: "🧑‍💼",
    category: "HR & Recruiting",
    description: "Screens resumes, sources candidates, and runs the hiring pipeline.",
    suggestedPrompts: [
      "Screen this resume for a cleared IT PM role",
      "Find 5 senior Java developers in DC",
      "Format this resume to our template",
    ],
  },
  {
    slug: "beady",
    name: "Beady",
    emoji: "🔭",
    category: "GovCon Intel",
    description: "Assesses opportunities, searches SAM.gov, and runs go/no go calls.",
    suggestedPrompts: [
      "Assess this opportunity for go/no-go",
      "Find SBIR opportunities closing this month",
      "What's our win probability on this RFP?",
    ],
  },
  {
    slug: "patch",
    name: "Patch",
    emoji: "🔧",
    category: "IT & Ops",
    description: "Handles Jira tickets, staff requests, doc Q&A, and ops triage.",
    suggestedPrompts: [
      "Create a ticket for the VPN issue affecting the BD team",
      "Search for open critical tickets",
      "Request a new hire for the CISA contract",
    ],
  },
  {
    slug: "money",
    name: "Money",
    emoji: "💰",
    category: "Finance",
    description: "Builds financial reports, budget analysis, and contract burn rates.",
    suggestedPrompts: [
      "Summarize revenue by contract for Q1 2025",
      "Which contracts are burning over budget?",
      "Show me indirect rate trends",
    ],
  },
  {
    slug: "cleo",
    name: "Cleo",
    emoji: "🏆",
    category: "Eminence",
    description: "Researches awards, runs recognition programs, and tracks eminence.",
    suggestedPrompts: [
      "What awards should Lumiture apply for this quarter?",
      "Run a fresh award sweep",
      "Which open government small business awards are high-prestige?",
    ],
  },
  {
    slug: "dewey",
    name: "Dewey",
    emoji: "📚",
    category: "Knowledge",
    description: "Curates the knowledge base with cited answers and sensitivity tags.",
    suggestedPrompts: [
      "What do we know about our past performance on cloud migrations?",
      "Give me an inventory of the knowledge base",
      "Lock the FY25 financial model to restricted",
    ],
  },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Agents</h1>
          <div className="sub">
            {AGENTS.length} agents · chat, upload files, and track runs
          </div>
        </div>
      </div>

      <div className="orch-grid ag-grid">
        {AGENTS.map((agent) => (
          <AgentCard key={agent.slug} agent={agent} />
        ))}
      </div>
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function AgentCard({ agent }: { agent: AgentMeta }) {
  return (
    <Link href={`/agents/${agent.slug}`} className="orch-card ag-card">
      <span className="ag-cat">{agent.category}</span>
      <div className="ag-art">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/agents/${agent.slug}.svg`} alt="" aria-hidden="true" />
      </div>
      <div className="ag-body">
        <div className="ag-h">
          <h3 className="ag-name">{agent.name}</h3>
          <span className="ag-chat">Chat <span aria-hidden="true">&rarr;</span></span>
        </div>
        <p className="ag-desc">{agent.description}</p>
      </div>
    </Link>
  );
}
