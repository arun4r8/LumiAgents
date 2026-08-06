import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cardFromRow, type AgentCard } from "@/lib/agent-catalog";
import { roleOf } from "@/lib/role";
import { agentOfOrchestration } from "@/lib/agent-style";
import { AgentMark } from "@/components/agent-mark";
import FirstRunNote from "@/components/first-run-note";

export const dynamic = "force-dynamic";

// Tier 1 (#67): the agents list renders from the catalog (code ∪ config), not a hardcoded
// array. Config agents created in-app appear here immediately. Ops see a "New agent" action
// and can see disabled agents (badged); endusers see only active agents.
// The catalog is read via the service-role admin client (bypasses RLS, reliable in
// server-render) rather than a cross-worker fetch that needs a session token.
//
// Redesign phase 4: the SVG portraits (public/agents/*.svg) and the emoji fallback are
// retired in favour of components/agent-mark.tsx. A config agent gets the same mark from
// its display name's first letter, so every agent — code or config — reads as one system.

export default async function AgentsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  // One source of truth for role — see lib/role.ts.
  const isOps = roleOf(user) === "ops";

  const admin = createAdminClient();
  const [agentRes, orchRes, toolRes] = await Promise.all([
    admin.schema("orchestration").from("agents")
      .select("slug, display_name, card, source, lifecycle")
      .order("display_name"),
    // "N orchestrations" is a capability descriptor, not business data: for a code
    // agent it is the `<slug>/…` namespace, for a config agent it is the tools wired
    // to it in orchestration.agent_tools (ops-only under RLS, hence the admin client
    // this page already holds). Only ACTIVE orchestrations count — a paused one is
    // not something the agent can run for you today.
    admin.schema("orchestration").from("orchestrations").select("name").eq("is_active", true),
    admin.schema("orchestration").from("agent_tools").select("agent_slug"),
  ]);

  // A failed catalog read used to fall through to `[]` and render a silent blank
  // page. Distinguish "the read broke" from "there are genuinely no agents".
  const readFailed = !!agentRes.error;
  const all: AgentCard[] = (agentRes.data ?? []).map((r) =>
    cardFromRow(r as Parameters<typeof cardFromRow>[0]),
  );
  const agents = isOps ? all : all.filter((a) => a.lifecycle === "active");

  const orchCount = new Map<string, number>();
  for (const o of (orchRes.data ?? []) as { name: string }[]) {
    const slug = agentOfOrchestration(o.name);
    if (slug) orchCount.set(slug, (orchCount.get(slug) ?? 0) + 1);
  }
  for (const t of (toolRes.data ?? []) as { agent_slug: string }[]) {
    orchCount.set(t.agent_slug, (orchCount.get(t.agent_slug) ?? 0) + 1);
  }

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
          {/* Orientation, not a stat: says what an agent is for before the grid. */}
          <div className="sub">
            {agents.length === 1 ? "One agent on staff" : `${agents.length} agents on staff`}
            {" · chat, attach files, or hand them a schedule"}
          </div>
        </div>
        {isOps && (
          <Link href="/agents/new" className="btn primary">
            <Plus size={14} /> New agent
          </Link>
        )}
      </div>

      {agents.length === 0 ? (
        <EmptyAgents readFailed={readFailed} isOps={isOps} />
      ) : (
        <div className="ag-grid">
          {agents.map((agent) => (
            <AgentCardTile
              key={agent.slug}
              agent={agent}
              orchestrations={orchCount.get(agent.slug) ?? 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function AgentCardTile({
  agent,
  orchestrations,
}: {
  agent: AgentCard;
  orchestrations: number;
}) {
  const disabled = agent.lifecycle === "disabled";
  return (
    <Link
      href={`/agents/${agent.slug}`}
      className={disabled ? "ag-card is-disabled" : "ag-card"}
    >
      <div className="ag-card-h">
        <AgentMark slug={agent.slug} name={agent.name} size={44} />
        <span className="tag tag-neutral">
          {disabled ? `${agent.category} · disabled` : agent.category}
        </span>
      </div>

      <div>
        <h2 className="ag-card-name">{agent.name}</h2>
        <p className="ag-card-desc">{agent.description}</p>
      </div>

      <div className="ag-card-f">
        <span className="ag-card-count">
          {orchestrations === 1 ? "1 orchestration" : `${orchestrations} orchestrations`}
        </span>
        <span className="ag-card-chat">Chat →</span>
      </div>
    </Link>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
//
// Missing entirely before this phase: when the catalog read failed, `data` was
// null, the map produced `[]`, and an enduser got a page with a heading and
// nothing under it. Both cases now say what happened and what to do next.

function EmptyAgents({ readFailed, isOps }: { readFailed: boolean; isOps: boolean }) {
  if (readFailed) {
    return (
      <div className="empty-state">
        <div className="empty-title">We couldn&apos;t load the agents</div>
        <p className="empty-body">
          The catalog didn&apos;t come back this time — that&apos;s a read failing on our
          side, not anything you did. Reload the page; if it keeps happening, tell ops so
          they can look at it.
        </p>
      </div>
    );
  }

  return (
    <div className="empty-state">
      <div className="empty-title">No agents on staff yet</div>
      <p className="empty-body">
        An agent is a coworker you talk to in plain language — you tell it what you need
        and it does the work.{" "}
        {isOps
          ? "Add the first one with New agent, above."
          : "Nobody has set one up in this workspace yet. Ask ops to add one."}
      </p>
    </div>
  );
}
