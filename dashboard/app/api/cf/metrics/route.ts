import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const CF_GQL = "https://api.cloudflare.com/client/v4/graphql";

export async function GET(): Promise<NextResponse> {
  // Auth check
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const scriptName =
    process.env.CF_WORKER_SCRIPT_NAME ?? "lumiagents-runtime";

  if (!accountId || !token) {
    return NextResponse.json(
      { error: "CF credentials not configured" },
      { status: 503 }
    );
  }

  const end = new Date();
  const start = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const query = `{
  viewer {
    accounts(filter: {accountTag: "${accountId}"}) {
      workersInvocationsAdaptive(
        filter: {datetime_geq: "${start.toISOString()}", datetime_leq: "${end.toISOString()}", scriptName: "${scriptName}"}
        limit: 10000
        orderBy: [datetime_ASC]
      ) {
        sum { requests errors }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { datetime status }
      }
    }
  }
}`;

  try {
    const res = await fetch(CF_GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Cloudflare API error: ${res.status}`, detail: text },
        { status: 502 }
      );
    }

    const data: unknown = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
