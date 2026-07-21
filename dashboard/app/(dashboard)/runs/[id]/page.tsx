import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { RunDetailClient } from "@/components/run-detail-client";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Fetch the run row, joined to orchestrations for name + version
  const { data: run } = await supabase
    .schema("orchestration")
    .from("runs")
    .select(
      "id, status, triggered_by, created_at, started_at, ended_at, input, output, error, orchestrations(name, version)"
    )
    .eq("id", id)
    .single();

  if (!run) notFound();

  // Fetch all steps for this run, ordered by step_index
  const { data: steps } = await supabase
    .schema("orchestration")
    .from("run_steps")
    .select(
      "id, step_index, step_name, step_type, status, input, output, error, started_at, ended_at, llm_model, llm_prompt, llm_response, llm_input_tokens, llm_output_tokens"
    )
    .eq("run_id", id)
    .order("step_index");

  // Fetch tool_calls for all steps (batched, avoids N+1)
  const stepIds = (steps ?? []).map((s) => s.id);
  const { data: toolCalls } =
    stepIds.length > 0
      ? await supabase
          .schema("orchestration")
          .from("tool_calls")
          .select(
            "id, run_step_id, tool_name, request, response, status, status_code, latency_ms, ended_at"
          )
          .in("run_step_id", stepIds)
      : { data: [] };

  // Supabase returns joined relations as arrays; normalise orchestrations to a
  // single object (or null) to match the Run interface expected by the client.
  const orchRaw = run.orchestrations;
  const orchestrations = Array.isArray(orchRaw)
    ? (orchRaw[0] as { name: string; version: number } | undefined) ?? null
    : (orchRaw as { name: string; version: number } | null);

  type RunProp = Parameters<typeof RunDetailClient>[0]["run"];
  const runProp: RunProp = {
    id: run.id as string,
    status: run.status as string,
    triggered_by: (run.triggered_by ?? null) as string | null,
    created_at: run.created_at as string,
    started_at: (run.started_at ?? null) as string | null,
    ended_at: (run.ended_at ?? null) as string | null,
    input: run.input as unknown,
    output: run.output as unknown,
    error: run.error as unknown,
    orchestrations,
  };

  return (
    <RunDetailClient
      run={runProp}
      steps={(steps ?? []) as Parameters<typeof RunDetailClient>[0]["steps"]}
      toolCalls={
        (toolCalls ?? []) as Parameters<typeof RunDetailClient>[0]["toolCalls"]
      }
    />
  );
}
