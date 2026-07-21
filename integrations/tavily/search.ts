import type { Env } from "../../runtime/src/types";
import { claimBudget, DAILY_BUDGET } from "../budget";

export interface TavilyResult {
  url: string;
  title: string;
  content: string;
}

// Thin wrapper over Tavily's /search. Used for GovCon incumbent research (D3).
// Degrades gracefully: with no API key (or on error) it returns [] so the
// assessment still completes; D3 then scores on "insufficient data".
export async function tavilySearch(
  env: Env,
  opts: { query: string; includeDomains?: string[]; maxResults?: number },
): Promise<TavilyResult[]> {
  if (!env.TAVILY_API_KEY) return [];
  if (!(await claimBudget(env, "tavily", DAILY_BUDGET.tavily))) return [];
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: opts.query,
        search_depth: "advanced",
        max_results: opts.maxResults ?? 5,
        ...(opts.includeDomains ? { include_domains: opts.includeDomains } : {}),
      }),
    });
    if (!res.ok) {
      console.warn(`[tavily] search → ${res.status}: ${await res.text()}`);
      return [];
    }
    const data = (await res.json()) as { results?: Array<{ url?: string; title?: string; content?: string }> };
    return (data.results ?? []).map((r) => ({
      url: r.url ?? "",
      title: r.title ?? "",
      content: r.content ?? "",
    }));
  } catch (err) {
    console.warn("[tavily] search error:", err);
    return [];
  }
}
