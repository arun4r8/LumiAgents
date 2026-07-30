// Single source of truth for LLM cost estimation across the dashboard.
//
// Both the Overview "Spend by agent" panel and the Infrastructure tab's
// "LLM Cost" KPI price token usage through these functions, so the two
// surfaces always reconcile (same per-model rates, same formula).
//
// Approximate list prices in USD per million tokens (MTok), matched by
// model-name family. These are estimates for a cost signal, not billing
// figures — update the numbers below when list prices change.

export interface ModelPrice {
  input: number;
  output: number;
}

const MODEL_PRICING: { family: string; input: number; output: number }[] = [
  { family: "sonnet", input: 3, output: 15 },
  { family: "haiku", input: 1, output: 5 },
];
// Default -> Sonnet pricing (covers opus / unknown models).
const DEFAULT_PRICING: ModelPrice = { input: 3, output: 15 };

export function priceFor(model: string | null | undefined): ModelPrice {
  const m = (model ?? "").toLowerCase();
  const hit = MODEL_PRICING.find((p) => m.includes(p.family));
  return hit ? { input: hit.input, output: hit.output } : DEFAULT_PRICING;
}

// Estimated USD cost for a batch of tokens on a given model.
export function costUsd(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = priceFor(model);
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}
