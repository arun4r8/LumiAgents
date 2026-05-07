import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { StatusBadge, TriggerChip, MonoId, JsonPanel, fmtAbs, fmtDuration } from "@/components/lumi";
import { StepsTimeline } from "@/components/steps-timeline";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: run } = await supabase
    .schema("orchestration")
    .from("runs")
    .select("*, orchestrations(name, version)")
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
  const isBlocked = run.status === "paused";

  return (
    <div className="page view-fade">
      {/* Back + title */}
      <div className="page-h">
        <div>
          <Link href="/runs" className="btn ghost sm" style={{ marginBottom: 8, marginLeft: -8 }}>
            <ArrowLeft style={{ width: 12, height: 12 }} /> All runs
          </Link>
          <h1 className="mono" style={{ fontSize: 17 }}>{orch?.name ?? "Run"}</h1>
          <div className="sub">Run detail</div>
        </div>
      </div>

      {/* Run header card */}
      <div className="runh">
        <div className="left">
          <div className="row gap-md">
            <StatusBadge status={run.status} />
            <TriggerChip trigger={{ kind: run.triggered_by ?? "—", label: run.triggered_by }} />
            <MonoId id={run.id} />
          </div>
          <div className="meta">
            <span>
              <span className="lbl">Started</span>
              <span className="v">{fmtAbs(run.created_at)}</span>
            </span>
            <span>
              <span className="lbl">Duration</span>
              <span className="v">{fmtDuration(run.started_at, run.ended_at)}</span>
            </span>
            {orch?.version != null && (
              <span>
                <span className="lbl">Version</span>
                <span className="v mono">v{orch.version}</span>
              </span>
            )}
            {isBlocked && (
              <span>
                <span className="lbl">Blocking</span>
                <span className="chip warn">awaiting approval</span>
              </span>
            )}
          </div>
        </div>
        <div className="right">
          {isBlocked && (
            <Link href="/approvals" className="btn primary">
              Resolve approval <ArrowRight style={{ width: 13, height: 13 }} />
            </Link>
          )}
        </div>
      </div>

      {/* Input / Output */}
      <div className="io-grid">
        <JsonPanel title="Input" value={run.input} defaultOpen={false} />
        <JsonPanel
          title={run.status === "failed" ? "Error" : "Output"}
          value={run.error ?? run.output}
          defaultOpen={false}
        />
      </div>

      {/* Steps timeline */}
      <div className="section-h">
        <h3>Steps</h3>
        <div className="meta">
          {(steps ?? []).filter((s) => s.status === "completed").length} of {(steps ?? []).length} completed
        </div>
      </div>

      <div className="card" style={{ padding: "16px 18px" }}>
        <StepsTimeline steps={steps ?? []} />
      </div>
    </div>
  );
}
