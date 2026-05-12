import type { RunContext } from "../../runtime/src/types";

const GITHUB_API = "https://api.github.com";

export async function githubFetch<T>(
  ctx: RunContext,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await ctx.fetch(`${GITHUB_API}${path}`, {
    method: options?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${ctx.env.GITHUB_API_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lumiagents/1.0",
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${options?.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export function vaultSourceUri(owner: string, repo: string, path: string): string {
  return `github:${owner}/${repo}:${path}`;
}
