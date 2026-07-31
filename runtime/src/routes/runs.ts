import type { Env } from "../types";
import { SupabaseClient } from "../db/client";
import { json, requireOpsToken, rateLimited } from "./helpers";

// The only prefixes this route will ever accept. `list_recent_runs`'s tool schema
// (agent-chat.ts) never exposes a prefix/agent field to Claude — the caller always
// derives it from the authenticated agentSlug — but this route re-validates anyway,
// as defense in depth against a caller bug or a future caller that isn't as careful.
const KNOWN_AGENT_PREFIXES = new Set([
  "angie/", "beady/", "cleo/", "dewey/", "patch/", "money/",
]);

export async function handleRuns(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname, searchParams } = url;

  // GET /api/runs?prefix=<slug>/&sinceHours=&limit=
  if (pathname === "/api/runs" && request.method === "GET") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const rl = await rateLimited(env, authResult.userId, "runs-list", 30);
    if (rl) return rl;

    const prefix = searchParams.get("prefix") ?? "";
    if (!KNOWN_AGENT_PREFIXES.has(prefix)) {
      return json({ error: `Unknown or missing prefix "${prefix}"` }, 400);
    }

    const sinceHours = Math.min(Math.max(Number(searchParams.get("sinceHours") ?? 24), 1), 24 * 30);
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 10), 1), 50);
    const sinceISO = new Date(Date.now() - sinceHours * 3_600_000).toISOString();

    const db = new SupabaseClient(env);
    const runs = await db.listRecentRuns({ prefix, sinceISO, limit });
    return json({ runs });
  }

  return null;
}
