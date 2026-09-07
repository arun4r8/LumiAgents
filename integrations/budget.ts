import type { Env } from "../runtime/src/types";

// Atomically claim `units` of a source's daily API budget (default 1).
//
// A caller that PAGES should claim an upper bound once rather than one unit per
// page. Each claim is an outbound fetch, and Cloudflare allows 50 subrequests per
// Worker invocation across a whole Workflow -- SAM.gov's paged walk was spending 7
// of that budget on counter increments.
//
// Claiming an upper bound over-counts when the walk stops early. That is the right
// direction: the quota exists to keep us clear of the provider's own rate limit. Returns true if the
// call is within the cap, false if the day's limit is already reached. Fails
// OPEN (returns true) if the counter is unreachable; never block real work on a
// metrics outage.
export async function claimBudget(env: Env, source: string, limit: number, units = 1): Promise<boolean> {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/claim_api_budget`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ p_source: source, p_limit: limit, p_units: units }),
    });
    if (!res.ok) return true;
    return (await res.json()) as boolean;
  } catch {
    return true;
  }
}

// Per-source daily caps. SAM free tier is ~1,000/day, so 200 leaves headroom for
// on-demand. SBIR has no key limit (tracked for visibility). Tavily free tier is
// ~1,000/month → ~30/day.
export const DAILY_BUDGET = {
  sam_gov: 200,
  sbir: 500,
  tavily: 30,
} as const;
