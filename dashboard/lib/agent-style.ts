// Agent identity.
//
// Redesign phase 1: the colours themselves no longer live here. Each agent owns
// an OKLCH *hue* declared as a CSS custom property in app/lumi.css
// (--hue-angie: 280, --hue-beady: 150, --hue-cleo: 210, --hue-dewey: 330,
// --hue-money: 90, --hue-patch: 40), and every derived value — the solid accent
// --agent-<slug>, the tonal surface --agent-<slug>-soft, and the letter-mark's
// oklch(var(--mark-l) 0.05 H) / oklch(var(--mtext-l) 0.09 H) pair — is composed
// in CSS so it flips with the theme instead of being frozen in JS.
//
// The helpers below just hand back the right `var(...)` reference. Agents that
// aren't in the code catalogue (config agents created in-app) fall through to
// the neutral hue, so an unknown slug still renders a coherent mark.

/** Slugs with a designer-assigned hue. Config agents fall back to neutral. */
export const AGENT_SLUGS = ["angie", "beady", "cleo", "dewey", "money", "patch"] as const;

export type AgentSlug = (typeof AGENT_SLUGS)[number];

const KNOWN = new Set<string>(AGENT_SLUGS);

/** Normalise a slug into something safe to splice into a CSS custom property name. */
function ident(agent: string): string {
  return agent.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/** True when the agent has its own hue rather than the neutral fallback. */
export function isKnownAgent(agent: string): boolean {
  return KNOWN.has(ident(agent));
}

/**
 * The agent's OKLCH hue, as a CSS value. Unknown slugs resolve to the neutral
 * fallback hue via the var() fallback, so this is safe for config agents.
 */
export function agentHue(agent: string): string {
  const slug = ident(agent);
  return KNOWN.has(slug) ? `var(--hue-${slug})` : "var(--hue-agent-default)";
}

/** Solid agent accent — dots, bars, names, chart series. */
export function agentColor(agent: string): string {
  const slug = ident(agent);
  return KNOWN.has(slug) ? `var(--agent-${slug})` : "var(--agent-default)";
}

/** Tonal agent surface — the same value the letter-mark's background uses. */
export function agentSoft(agent: string): string {
  const slug = ident(agent);
  return KNOWN.has(slug) ? `var(--agent-${slug}-soft)` : "var(--agent-default-soft)";
}

/**
 * Back-compat shim for the old `AGENT_COLOR[slug]` lookups. Kept so nothing
 * breaks mid-redesign; prefer agentColor().
 */
export const AGENT_COLOR: Record<string, string> = Object.fromEntries(
  AGENT_SLUGS.map((slug) => [slug, `var(--agent-${slug})`]),
);
