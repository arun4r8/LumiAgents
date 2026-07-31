import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SpendRow } from "@/lib/spend";

const VALID_DAYS = new Set([1, 7, 30]);

export async function GET(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const daysParam = Number(new URL(request.url).searchParams.get("days"));
  const days = VALID_DAYS.has(daysParam) ? daysParam : 30;

  // agent_spend is SECURITY DEFINER + is_ops-gated: non-ops users get [] rows.
  const { data, error } = await supabase.rpc("agent_spend", { p_days: days });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json((data ?? []) as SpendRow[]);
}
