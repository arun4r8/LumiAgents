import type { Env } from "../types";
import { json, requireUser } from "./helpers";

/**
 * Delivery analytics: the shape of the backlog, read from GitHub.
 *
 * Lives in the runtime rather than the dashboard because GITHUB_API_TOKEN is a
 * Worker secret. The dashboard reaches it through the service binding, like every
 * other server-side runtime call.
 *
 * Derived from LABELS, not from the Project board. The board's columns
 * (No Status / Current / Backlog) mirror the `status:` labels one-for-one, and
 * labels come back from the REST issues endpoint in the same request that carries
 * everything else. Reading the Project itself would mean GraphQL, a
 * project-scoped token, and a second thing to keep in sync -- for the same numbers.
 *
 * If the board and the labels ever diverge, the labels are what this reports and
 * the board is what a human sees. Worth knowing before trusting a discrepancy.
 */

const OWNER = "LumitureLabs";
const REPO = "LumiAgents";

interface GhLabel {
  name: string;
}
interface GhIssue {
  number: number;
  title: string;
  labels: GhLabel[];
  pull_request?: unknown;
  created_at: string;
  updated_at: string;
}

export interface DeliveryAnalytics {
  openIssues: number;
  byStatus: { label: string; count: number }[];
  byArea: { label: string; count: number }[];
  /** Open issues untouched for a while: the backlog's quiet corner. */
  staleOver30d: number;
  /** Closed in the last 7 days, as a throughput signal. */
  closedThisWeek: number;
  oldestOpenDays: number | null;
  generatedAt: string;
}

function labelValue(labels: GhLabel[], prefix: string): string | null {
  const hit = labels.find((l) => l.name.startsWith(prefix));
  return hit ? hit.name.slice(prefix.length).trim() : null;
}

function rank<T extends string>(items: (T | null)[], fallback: string): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const i of items) {
    const k = i ?? fallback;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

async function gh<T>(env: Env, path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_API_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lumiagents/1.0",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export async function handleAnalytics(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== "/api/analytics/delivery" || request.method !== "GET") return null;

  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;

  try {
    const now = Date.now();
    const weekAgo = new Date(now - 7 * 86_400_000).toISOString();

    // Two requests, not one per issue. `per_page=100` covers a backlog this size;
    // if it ever exceeds that, the count is capped rather than silently partial --
    // hence `openIssues` coming from the array length and not a separate total.
    const open = await gh<GhIssue[]>(env, `/repos/${OWNER}/${REPO}/issues?state=open&per_page=100`);
    const recentlyClosed = await gh<GhIssue[]>(
      env,
      `/repos/${OWNER}/${REPO}/issues?state=closed&since=${weekAgo}&per_page=100`,
    );

    // The issues endpoint returns PRs too. They are not backlog.
    const issues = open.filter((i) => !i.pull_request);
    const closed = recentlyClosed.filter((i) => !i.pull_request);

    const oldest = issues.reduce<number | null>((acc, i) => {
      const days = Math.floor((now - new Date(i.created_at).getTime()) / 86_400_000);
      return acc === null || days > acc ? days : acc;
    }, null);

    const body: DeliveryAnalytics = {
      openIssues: issues.length,
      byStatus: rank(issues.map((i) => labelValue(i.labels, "status:")), "no status"),
      byArea: rank(issues.map((i) => labelValue(i.labels, "area:")), "unassigned"),
      staleOver30d: issues.filter((i) => now - new Date(i.updated_at).getTime() > 30 * 86_400_000).length,
      closedThisWeek: closed.length,
      oldestOpenDays: oldest,
      generatedAt: new Date().toISOString(),
    };

    return json(body, 200);
  } catch (err) {
    // A GitHub outage must not take the analytics page down with it. The page shows
    // its BD half and says the delivery half is unavailable.
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}
