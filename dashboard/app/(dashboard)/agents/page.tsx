import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cardFromRow, type AgentCard } from "@/lib/agent-catalog";
import { roleOf } from "@/lib/role";
import FirstRunNote from "@/components/first-run-note";

export const dynamic = "force-dynamic";

// Tier 1 (#67): the agents list renders from the catalog (code ∪ config), not a hardcoded
// array. Config agents created in-app appear here immediately. Ops see a "New agent" action
// and can see disabled agents (badged); endusers see only active agents.
// The catalog is read via the service-role admin client (bypasses RLS, reliable in
// server-render) rather than a cross-worker fetch that needs a session token.

export default async function AgentsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  // One source of truth for role — see lib/role.ts.
  const isOps = roleOf(user) === "ops";

  const { data: rows } = await createAdminClient()
    .schema("orchestration").from("agents")
    .select("slug, display_name, card, source, lifecycle")
    .order("display_name");
  const all: AgentCard[] = (rows ?? []).map((r) => cardFromRow(r as Parameters<typeof cardFromRow>[0]));
  const agents = isOps ? all : all.filter((a) => a.lifecycle === "active");

  // M1 (#71): the enduser welcome. /agents is the enduser landing (app/page.tsx
  // sends non-ops here), so the welcome belongs on this screen. Persisted in
  // user_metadata.onboarded_at, not localStorage.
  const showWelcome = !isOps && !user?.user_metadata?.onboarded_at;

  return (
    <div className="page view-fade">
      {showWelcome && (
        <FirstRunNote
          variant="welcome"
          title="Welcome to LumiAgents"
          body="An agent is a coworker you talk to in plain language. Tell one what you need — screen these resumes, find awards we could enter — and it does the work. Anything it does becomes a run: a step-by-step record you can open and watch, listed under Runs. You can also drop files into Library so the agents can search them. Agents take real actions, so read what one tells you it is about to do."
          dismissLabel="Got it"
        />
      )}
      <div className="page-h">
        <div>
          <h1>Agents</h1>
          <div className="sub">
            {agents.length} agents · chat, upload files, and track runs
          </div>
        </div>
        {isOps && (
          <Link href="/agents/new" className="btn primary" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Plus size={14} /> New agent
          </Link>
        )}
      </div>

      <div className="orch-grid ag-grid">
        {agents.map((agent) => (
          <AgentCardTile key={agent.slug} agent={agent} />
        ))}
      </div>
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function AgentCardTile({ agent }: { agent: AgentCard }) {
  const disabled = agent.lifecycle === "disabled";
  return (
    <Link href={`/agents/${agent.slug}`} className="orch-card ag-card" style={disabled ? { opacity: 0.6 } : undefined}>
      <span className="ag-cat">
        {agent.category}
        {disabled && <span style={{ marginLeft: 6, color: "var(--err)" }}>· disabled</span>}
      </span>
      <div className="ag-art">
        {agent.source === "code" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/agents/${agent.slug}.svg`} alt="" aria-hidden="true" />
        ) : (
          <span aria-hidden="true" style={{ fontSize: 44, lineHeight: 1 }}>{agent.emoji}</span>
        )}
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
