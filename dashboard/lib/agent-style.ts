// Agent accent colors — reused from the Orchestrations page palette, extended to
// the two agents (cleo, dewey) that page doesn't enumerate. Shared by the
// Overview spend panel and the Infrastructure per-agent spend breakdown.

export const AGENT_COLOR: Record<string, string> = {
  angie: "oklch(62% 0.18 280)",
  beady: "oklch(58% 0.17 145)",
  cleo: "oklch(60% 0.17 200)",
  dewey: "oklch(60% 0.16 330)",
  money: "oklch(62% 0.16 85)",
  patch: "oklch(60% 0.16 30)",
};

export function agentColor(agent: string): string {
  return AGENT_COLOR[agent.toLowerCase()] ?? "var(--ink-3)";
}
