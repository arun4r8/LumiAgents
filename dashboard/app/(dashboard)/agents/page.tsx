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
    description: "Resume screening, candidate sourcing, and hiring pipeline management.",
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
    description: "Opportunity assessment, SAM.gov search, and go/no-go analysis.",
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
    description: "Jira tickets, staff requests, document Q&A, and ops triage.",
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
    description: "Financial reports, budget analysis, and contract burn rates.",
    suggestedPrompts: [
      "Summarize revenue by contract for Q1 2025",
      "Which contracts are burning over budget?",
      "Show me indirect rate trends",
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

      <div className="orch-grid">
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
    <div className="orch-card agent-card">
      {/* Header */}
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="agent-emoji" aria-hidden="true">{agent.emoji}</span>
          <div className="nm">{agent.name}</div>
        </div>
        <span className="chip accent">{agent.category}</span>
      </div>

      <div className="desc">{agent.description}</div>

      {/* Footer */}
      <div className="ft">
        <span />
        <Link href={`/agents/${agent.slug}`} className="btn accent sm">
          Chat →
        </Link>
      </div>

      <style>{`
        .agent-emoji {
          font-size: 22px;
          line-height: 1;
          flex-shrink: 0;
        }
        .agent-card .nm {
          font-family: var(--sans);
          font-size: 15px;
          font-weight: 600;
          letter-spacing: -0.01em;
        }
        .agent-card .ft {
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-top: 1px solid var(--line);
          padding-top: 10px;
        }
      `}</style>
    </div>
  );
}
