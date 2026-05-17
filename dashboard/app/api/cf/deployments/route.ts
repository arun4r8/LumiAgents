import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const CF_BASE = "https://api.cloudflare.com/client/v4";

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

  try {
    const res = await fetch(
      `${CF_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Cloudflare API error: ${res.status}`, detail: text },
        { status: 502 }
      );
    }

    const data = (await res.json()) as { result?: unknown[] };
    return NextResponse.json(data.result ?? []);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
