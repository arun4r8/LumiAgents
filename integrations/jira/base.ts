import type { RunContext } from "../../runtime/src/types";

/**
 * Call the Jira REST API v3.
 * Auth: HTTP Basic — base64(email:api_token).
 * JIRA_BASE_URL  e.g. "https://lumiture.atlassian.net"  (var in wrangler.toml)
 * JIRA_EMAIL     Atlassian account email                  (wrangler secret)
 * JIRA_API_TOKEN API token from id.atlassian.com          (wrangler secret)
 */
export async function callJira<T>(
  ctx: RunContext,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,          // e.g. "/rest/api/3/issue"
  body?: unknown,
): Promise<T> {
  const credentials = btoa(`${ctx.env.JIRA_EMAIL}:${ctx.env.JIRA_API_TOKEN}`);

  const headers: Record<string, string> = {
    "Authorization": `Basic ${credentials}`,
    "Accept": "application/json",
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await ctx.fetch(`${ctx.env.JIRA_BASE_URL}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira ${method} ${path} → ${res.status}: ${text}`);
  }

  // 204 No Content (transitions, some PUTs) → return empty object
  if (res.status === 204) return {} as T;

  return res.json() as Promise<T>;
}
