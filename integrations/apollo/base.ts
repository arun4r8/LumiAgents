import type { RunContext } from "../../runtime/src/types";
import { callJson } from "../http";

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
  return callJson<T>(
    ctx.fetch,
    `${APOLLO_BASE}/${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": ctx.env.APOLLO_API_KEY ?? "",
      },
      body: JSON.stringify(body),
    },
    { label: `Apollo API ${path}` },
  );
}
