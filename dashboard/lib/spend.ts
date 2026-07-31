// Shared spend aggregation + formatting, used by the Overview "Spend by agent"
// panel and the Infrastructure Metrics tab. Cost is priced through the shared
// lib/llm-pricing table so every surface reconciles.

import { costUsd } from "@/lib/llm-pricing";

export interface SpendRow {
  agent: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  calls: number;
}

export type SpendWindow = "24h" | "7d" | "30d";

export const SPEND_WINDOWS: { key: SpendWindow; label: string; days: number }[] = [
  { key: "24h", label: "24h", days: 1 },
  { key: "7d", label: "7d", days: 7 },
  { key: "30d", label: "30d", days: 30 },
];

export function daysFor(w: SpendWindow): number {
  return SPEND_WINDOWS.find((x) => x.key === w)?.days ?? 30;
}

export interface AgentSpend {
  agent: string;
  cost: number;
  tokens: number;
  calls: number;
}

export function aggregateByAgent(rows: SpendRow[]): {
  agents: AgentSpend[];
  totalCost: number;
  totalTokens: number;
} {
  const byAgent = new Map<string, AgentSpend>();
  for (const row of rows) {
    const cost = costUsd(row.model, row.input_tokens, row.output_tokens);
    const tokens = row.input_tokens + row.output_tokens;
    const cur = byAgent.get(row.agent) ?? {
      agent: row.agent,
      cost: 0,
      tokens: 0,
      calls: 0,
    };
    cur.cost += cost;
    cur.tokens += tokens;
    cur.calls += row.calls;
    byAgent.set(row.agent, cur);
  }
  const agents = [...byAgent.values()].sort((a, b) => b.cost - a.cost);
  return {
    agents,
    totalCost: agents.reduce((s, a) => s + a.cost, 0),
    totalTokens: agents.reduce((s, a) => s + a.tokens, 0),
  };
}

// "1.2M" / "845K" / "312" style token formatting.
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return `${n}`;
}

export function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}
