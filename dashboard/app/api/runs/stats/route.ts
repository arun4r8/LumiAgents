import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface RunRow {
  status: string;
  triggered_by: string | null;
}

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .schema("orchestration")
    .from("runs")
    .select("status, triggered_by")
    .gte("created_at", since);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as RunRow[];
  const total = rows.length;
  const succeeded = rows.filter((r) => r.status === "completed").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const cronTriggered = rows.filter((r) => r.triggered_by === "cron").length;

  return NextResponse.json({ total, succeeded, failed, cronTriggered });
}
