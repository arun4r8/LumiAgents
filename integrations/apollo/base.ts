import type { RunContext } from "../../runtime/src/types";

const APOLLO_BASE = "https://api.apollo.io/v1";

/**
 * POST to the Apollo API with JSON body.
 * Apollo expects the api_key inside the JSON body (their convention).
 * We add it here so callers never handle it directly.
 */
export async function callApollo<T>(
  ctx: RunContext,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await ctx.fetch(`${APOLLO_BASE}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify({
      ...body,
      api_key: ctx.env.APOLLO_API_KEY,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apollo API ${path} → ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}
