import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDuration, STATUS_COLORS } from "@/lib/utils";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: run } = await supabase
    .schema("orchestration")
    .from("runs")
    .select(`*, orchestrations ( name, version )`)
    .eq("id", id)
    .single();

  if (!run) notFound();

  const { data: steps } = await supabase
    .schema("orchestration")
    .from("run_steps")
    .select("*")
    .eq("run_id", id)
    .order("step_index");

  const orch = run.orchestrations as { name: string; version: number } | null;

  return (
    <div className="p-8 max-w-5xl">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-semibold">{orch?.name ?? "Run"}</h1>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[run.status] ?? ""}`}>
            {run.status}
          </span>
        </div>
        <p className="text-sm text-gray-500">
          {run.id} · {run.triggered_by} · {formatDate(run.created_at)} · {formatDuration(run.started_at, run.ended_at)}
        </p>
      </div>

      {/* Input / Output */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        {[
          { label: "Input", data: run.input },
          { label: run.status === "failed" ? "Error" : "Output", data: run.error ?? run.output },
        ].map(({ label, data }) => (
          <div key={label} className="bg-white rounded-xl border p-4">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">{label}</h2>
            <pre className="text-xs font-mono text-gray-700 whitespace-pre-wrap break-words max-h-48 overflow-auto">
              {data ? JSON.stringify(data, null, 2) : "—"}
            </pre>
          </div>
        ))}
      </div>

      {/* Steps timeline */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Steps</h2>
      <div className="space-y-2">
        {(steps ?? []).map((step) => (
          <details key={step.id} className="bg-white rounded-xl border group">
            <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer list-none">
              <span className="text-gray-400 text-xs font-mono w-5 text-right">{step.step_index}</span>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[step.status] ?? ""}`}>
                {step.status}
              </span>
              <span className="text-sm font-medium flex-1">{step.step_name}</span>
              <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">{step.step_type}</span>
              <span className="text-xs text-gray-400">{formatDuration(step.started_at, step.ended_at)}</span>
            </summary>
            <div className="px-4 pb-4 border-t mt-0 grid grid-cols-2 gap-4 pt-3">
              <div>
                <p className="text-xs font-medium text-gray-400 mb-1">Input</p>
                <pre className="text-xs font-mono text-gray-600 whitespace-pre-wrap break-words max-h-40 overflow-auto">
                  {step.input ? JSON.stringify(step.input, null, 2) : "—"}
                </pre>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-400 mb-1">{step.status === "failed" ? "Error" : "Output"}</p>
                <pre className="text-xs font-mono text-gray-600 whitespace-pre-wrap break-words max-h-40 overflow-auto">
                  {(step.error ?? step.output) ? JSON.stringify(step.error ?? step.output, null, 2) : "—"}
                </pre>
              </div>
              {step.llm_model && (
                <div className="col-span-2 bg-purple-50 rounded-lg p-3">
                  <p className="text-xs font-medium text-purple-700 mb-1">
                    {step.llm_model} · {step.llm_input_tokens}↑ {step.llm_output_tokens}↓ tokens
                  </p>
                  {step.llm_prompt && (
                    <pre className="text-xs text-purple-800 whitespace-pre-wrap max-h-32 overflow-auto">{step.llm_prompt}</pre>
                  )}
                </div>
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
