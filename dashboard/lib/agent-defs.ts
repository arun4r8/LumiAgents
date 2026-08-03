// Server-side accessor for the six agents' code-defined persona + tool set, sourced from
// the runtime agent definitions (agents/<slug>/index.ts) — the single source of truth.
// Used by the agent page + saveAgentOverrides so the "Customize" panel can show the base
// prompt read-only and offer checkboxes over the agent's REAL tools (never a duplicate).
//
// The runtime agent files are pure data (they import only ./types), so pulling them into
// the dashboard build is safe and adds no runtime dependencies. Do not import this from a
// client component — keep it to server components and server actions.
import { AGENTS } from "../../agents";

export interface AgentDef {
  slug: string;
  displayName: string;
  systemPrompt: string;
  tools: { name: string; description: string }[];
}

export function getAgentDef(slug: string): AgentDef | null {
  const a = AGENTS[slug];
  if (!a) return null;
  return {
    slug: a.slug,
    displayName: a.displayName,
    systemPrompt: a.systemPrompt,
    tools: a.tools.map((t) => ({ name: t.name, description: t.description })),
  };
}
