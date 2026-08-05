import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { roleOf } from "@/lib/role";
import { loadRunSnapshot } from "@/lib/run-snapshot";
import { outputBody } from "@/lib/run-view";
import {
  RunDetailClient,
  type StepTech,
  type StepToolCall,
} from "@/components/run-detail-client";

export const dynamic = "force-dynamic";

/**
 * Run detail.
 *
 * The run itself is loaded through `loadRunSnapshot`, the same RLS-scoped read
 * the polled /api/runs/:id endpoint uses, so the server render and every
 * subsequent live update are the same shape produced by the same code. A run the
 * caller cannot read under RLS is a 404 here, exactly as before.
 *
 * The extra ops payload below (prompts, raw input/output, tool calls) is fetched
 * ONLY for ops users and passed as pre-serialised strings, so the client never has
 * to JSON.stringify anything at a reader and a non-ops session never receives the
 * raw material at all.
 */
export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const snapshot = await loadRunSnapshot(id);
  if (!snapshot) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isOps = roleOf(user) === "ops";

  const tech = isOps ? await loadTech(id) : null;

  // Ops also get the raw run output; everyone gets the plain-language line when
  // the orchestration wrote one.
  let resultNote: string | null = null;
  let outputDetail: string | null = null;
  if (snapshot.status === "completed") {
    const { data: outRow } = await supabase
      .schema("orchestration")
      .from("runs")
      .select("output")
      .eq("id", id)
      .maybeSingle();
    const output = (outRow as { output: unknown } | null)?.output;
    resultNote = outputBody(output);
    if (isOps && output != null) outputDetail = safeJson(output);
  }

  return (
    <RunDetailClient
      snapshot={snapshot}
      tech={tech}
      resultNote={resultNote}
      outputDetail={outputDetail}
    />
  );
}

// ─── Ops-only technical payload ──────────────────────────────────────────────

function safeJson(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function loadTech(runId: string): Promise<StepTech[]> {
  const supabase = await createClient();

  const { data: steps } = await supabase
    .schema("orchestration")
    .from("run_steps")
    .select(
      "id, input, output, llm_model, llm_prompt, llm_response, llm_input_tokens, llm_output_tokens",
    )
    .eq("run_id", runId)
    .order("step_index");

  const rows = (steps ?? []) as unknown as {
    id: string;
    input: unknown;
    output: unknown;
    llm_model: string | null;
    llm_prompt: string | null;
    llm_response: string | null;
    llm_input_tokens: number | null;
    llm_output_tokens: number | null;
  }[];

  if (rows.length === 0) return [];

  const { data: toolCalls } = await supabase
    .schema("orchestration")
    .from("tool_calls")
    .select("id, run_step_id, tool_name, request, response, status, status_code, latency_ms")
    .in(
      "run_step_id",
      rows.map((r) => r.id),
    );

  const byStep = new Map<string, StepToolCall[]>();
  for (const raw of (toolCalls ?? []) as unknown as {
    id: string;
    run_step_id: string;
    tool_name: string;
    request: unknown;
    response: unknown;
    status: string;
    status_code: number | null;
    latency_ms: number | null;
  }[]) {
    const list = byStep.get(raw.run_step_id) ?? [];
    list.push({
      id: raw.id,
      name: raw.tool_name,
      status: raw.status,
      statusCode: raw.status_code,
      latencyMs: raw.latency_ms,
      request: safeJson(raw.request),
      response: safeJson(raw.response),
    });
    byStep.set(raw.run_step_id, list);
  }

  return rows.map((r) => ({
    stepId: r.id,
    model: r.llm_model,
    inputTokens: r.llm_input_tokens,
    outputTokens: r.llm_output_tokens,
    prompt: r.llm_prompt,
    response: r.llm_response,
    input: safeJson(r.input),
    output: safeJson(r.output),
    toolCalls: byStep.get(r.id) ?? [],
  }));
}
