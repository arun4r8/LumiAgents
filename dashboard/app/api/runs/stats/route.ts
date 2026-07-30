import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { costUsd } from "@/lib/llm-pricing";

interface RunRow {
  status: string;
  triggered_by: string | null;
}

interface StepRow {
  llm_model: string | null;
  llm_input_tokens: number | null;
  llm_output_tokens: number | null;
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

  const [runsResult, stepsResult] = await Promise.all([
    supabase
      .schema("orchestration")
      .from("runs")
      .select("status, triggered_by")
      .gte("created_at", since),
    supabase
      .schema("orchestration")
      .from("run_steps")
      .select("llm_model, llm_input_tokens, llm_output_tokens")
      .gte("started_at", since)
      .not("llm_model", "is", null),
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
  // Price per-model via the shared table so this reconciles with the
  // Overview "Spend by agent" panel (both use lib/llm-pricing).
  const estimatedCostUsd = steps.reduce(
    (s, r) => s + costUsd(r.llm_model, r.llm_input_tokens ?? 0, r.llm_output_tokens ?? 0),
    0,
  );

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
