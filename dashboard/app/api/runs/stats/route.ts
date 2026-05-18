import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface RunRow {
  status: string;
  triggered_by: string | null;
}

interface StepRow {
  llm_input_tokens: number | null;
  llm_output_tokens: number | null;
}

// Sonnet 4.6 pricing as of 2026-05: $3/M input, $15/M output
const INPUT_COST_PER_M = 3;
const OUTPUT_COST_PER_M = 15;

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [runsResult, stepsResult] = await Promise.all([
    supabase
      .schema("orchestration")
      .from("runs")
      .select("status, triggered_by")
      .gte("created_at", since),
    supabase
      .schema("orchestration")
      .from("run_steps")
      .select("llm_input_tokens, llm_output_tokens")
      .gte("started_at", since)
      .in("step_type", ["llm_decide", "llm_extract"]),
  ]);

  if (runsResult.error) {
    return NextResponse.json({ error: runsResult.error.message }, { status: 500 });
  }

  const rows = (runsResult.data ?? []) as RunRow[];
  const total = rows.length;
  const succeeded = rows.filter((r) => r.status === "completed").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const cronTriggered = rows.filter((r) => r.triggered_by === "cron").length;

  const steps = (stepsResult.data ?? []) as StepRow[];
  const totalInputTokens = steps.reduce((s, r) => s + (r.llm_input_tokens ?? 0), 0);
  const totalOutputTokens = steps.reduce((s, r) => s + (r.llm_output_tokens ?? 0), 0);
  const estimatedCostUsd =
    (totalInputTokens / 1_000_000) * INPUT_COST_PER_M +
    (totalOutputTokens / 1_000_000) * OUTPUT_COST_PER_M;

  return NextResponse.json({
    total,
    succeeded,
    failed,
    cronTriggered,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUsd,
  });
}
