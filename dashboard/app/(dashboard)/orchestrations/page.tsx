import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { Clock, ArrowRight } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function OrchestrationsPage() {
  const supabase = await createClient();

  const { data: orchestrations } = await supabase
    .schema("orchestration")
    .from("orchestrations")
    .select("id, name, version, description, is_active, cron, created_at")
    .order("name");

  const orcList = (orchestrations ?? []) as {
    id: string;
    name: string;
    version: string | number;
    description: string | null;
    is_active: boolean;
    cron: string | null;
    created_at: string;
  }[];

  const active = orcList.filter((o) => o.is_active);

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Orchestrations</h1>
          <div className="sub">{orcList.length} catalogued · {active.length} active</div>
        </div>
      </div>

      {orcList.length === 0 ? (
        <div className="empty">
          <h4>No orchestrations registered yet.</h4>
          <p>Deploy the runtime and seed the orchestrations table.</p>
        </div>
      ) : (
        <div className="orch-grid">
          {orcList.map((o) => (
            <div key={o.id} className="orch-card">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <div className="nm">{o.name}</div>
                <span className={`chip ${o.is_active ? "ok" : "muted"}`}>
                  {o.is_active ? "active" : "inactive"}
                </span>
              </div>
              {o.description && <div className="desc">{o.description}</div>}
              <div className="meta">
                <span className="chip muted mono" style={{ fontSize: 10.5 }}>v{o.version}</span>
                {o.cron && (
                  <span className="chip accent">
                    <Clock style={{ width: 10, height: 10 }} /> {o.cron}
                  </span>
                )}
              </div>
              <div className="ft">
                <span className="mono tabular" style={{ fontSize: 12 }}>—</span>
                <Link href={`/runs?orchestration=${encodeURIComponent(o.name)}`} className="row gap-sm">
                  View runs <ArrowRight style={{ width: 12, height: 12 }} />
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
