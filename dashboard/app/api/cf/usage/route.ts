import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const CF_BASE = "https://api.cloudflare.com/client/v4";
const CF_GQL = "https://api.cloudflare.com/client/v4/graphql";

export interface UsageData {
  requestsToday: number;
  workersCount: number;
  plan: "free" | "paid";
  limits: {
    requestsPerDay: number;
    workersMax: number | null;
  };
}

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !token) {
    return NextResponse.json({ error: "CF credentials not configured" }, { status: 503 });
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const now = new Date();

  const [gqlRes, scriptsRes, subsRes] = await Promise.all([
    // Account-wide request count for today (no scriptName filter)
    fetch(CF_GQL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: `{
          viewer {
            accounts(filter: {accountTag: "${accountId}"}) {
              workersInvocationsAdaptive(
                filter: {datetime_geq: "${startOfDay.toISOString()}", datetime_leq: "${now.toISOString()}"}
                limit: 10000
              ) {
                sum { requests }
              }
            }
          }
        }`,
      }),
    }),
    // Count deployed worker scripts
    fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts`, { headers }),
    // Try to determine plan from subscriptions
    fetch(`${CF_BASE}/accounts/${accountId}/subscriptions`, { headers }),
  ]);

  let requestsToday = 0;
  if (gqlRes.ok) {
    type GqlResp = { data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum: { requests: number } }> }> } } };
    const gqlData = await gqlRes.json() as GqlResp;
    const buckets = gqlData.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    requestsToday = buckets.reduce((s, b) => s + (b.sum?.requests ?? 0), 0);
  }

  let workersCount = 0;
  if (scriptsRes.ok) {
    type ScriptsResp = { result?: unknown[] };
    const scriptsData = await scriptsRes.json() as ScriptsResp;
    workersCount = scriptsData.result?.length ?? 0;
  }

  // Workers Paid plan is detected by any active Workers subscription.
  // Workflows require the Paid plan, so if Workflows are in use we can assume paid.
  let plan: "free" | "paid" = "free";
  if (subsRes.ok) {
    type SubsResp = { result?: Array<{ product?: { name?: string } }> };
    const subsData = await subsRes.json() as SubsResp;
    const hasPaid = (subsData.result ?? []).some(
      (s) => s.product?.name?.toLowerCase().includes("worker"),
    );
    if (hasPaid) plan = "paid";
  }

  const limits = {
    free: { requestsPerDay: 100_000, workersMax: 30 },
    paid: { requestsPerDay: 10_000_000, workersMax: null },
  }[plan];

  return NextResponse.json({ requestsToday, workersCount, plan, limits } satisfies UsageData);
}
