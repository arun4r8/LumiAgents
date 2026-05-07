import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function OrchestrationsPage() {
  const supabase = await createClient();

  const { data: orchestrations } = await supabase
    .schema("orchestration")
    .from("orchestrations")
    .select("id, name, version, description, is_active, cron, created_at")
    .order("name");

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Orchestrations</h1>
        <p className="text-sm text-gray-500 mt-1">Available workflows you can trigger</p>
      </div>

      <div className="grid gap-3">
        {(orchestrations ?? []).map((o) => (
          <div key={o.id} className="bg-white rounded-xl border p-5 flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h2 className="font-medium text-sm">{o.name}</h2>
                <span className="text-xs text-gray-400">v{o.version}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${o.is_active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                  {o.is_active ? "active" : "inactive"}
                </span>
                {o.cron && <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">{o.cron}</span>}
              </div>
              {o.description && <p className="text-sm text-gray-500">{o.description}</p>}
            </div>
            <Link href={`/runs?orchestration=${o.name}`}
              className="shrink-0 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors">
              View runs →
            </Link>
          </div>
        ))}
        {(orchestrations ?? []).length === 0 && (
          <div className="bg-white rounded-xl border p-8 text-center text-gray-400 text-sm">
            No orchestrations registered yet. Deploy the runtime and seed the orchestrations table.
          </div>
        )}
      </div>
    </div>
  );
}
