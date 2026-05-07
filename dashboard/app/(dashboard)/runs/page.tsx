import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDuration, STATUS_COLORS } from "@/lib/utils";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const supabase = await createClient();

  const { data: runs, error } = await supabase
    .schema("orchestration")
    .from("runs")
    .select(`id, status, triggered_by, created_at, started_at, ended_at, orchestrations ( name, version )`)
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Runs</h1>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700 mb-4">
          {error.message}
        </div>
      )}

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              {["Orchestration", "Status", "Trigger", "Started", "Duration"].map((h) => (
                <th key={h} className="text-left px-4 py-3 font-medium text-gray-500 text-xs uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {(runs ?? []).map((run) => {
              const orch = run.orchestrations as unknown as { name: string; version: number } | null;
              return (
                <tr key={run.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/runs/${run.id}`} className="font-medium text-blue-600 hover:underline">
                      {orch?.name ?? "—"}
                    </Link>
                    <span className="ml-1.5 text-xs text-gray-400">v{orch?.version}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[run.status] ?? ""}`}>
                      {run.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{run.triggered_by}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(run.created_at)}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDuration(run.started_at, run.ended_at)}</td>
                </tr>
              );
            })}
            {(runs ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
