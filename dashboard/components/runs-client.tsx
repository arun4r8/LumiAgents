"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Search, RefreshCw, X } from "lucide-react";
import { StatusBadge, TriggerChip, MonoId, fmtAbs, fmtDuration } from "@/components/lumi";

interface Run {
  id: string;
  status: string;
  triggered_by: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  orchestrations: { name: string; version: number } | null;
}

const ALL_STATUSES = ["all", "running", "paused", "completed", "failed", "cancelled", "pending"] as const;

export function RunsClient({
  runs,
  initialFilter,
}: {
  runs: Run[];
  initialFilter?: string;
}) {
  const router = useRouter();
  const [orchFilter, setOrchFilter] = useState<string | null>(initialFilter ?? null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return runs.filter((r) => {
      const name = r.orchestrations?.name ?? "";
      if (orchFilter && name !== orchFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!r.id.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [runs, orchFilter, statusFilter, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: runs.length };
    for (const r of runs) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [runs]);

  function clearOrchFilter() {
    setOrchFilter(null);
    router.push("/runs");
  }

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Runs</h1>
          <div className="sub">Real-time history · {runs.length} runs loaded</div>
        </div>
        <div className="row gap-sm">
          <div className="search">
            <Search />
            <input
              placeholder="Search by id or orchestration…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button className="btn icon" title="Refresh" onClick={() => router.refresh()}>
            <RefreshCw style={{ width: 13, height: 13 }} />
          </button>
        </div>
      </div>

      {orchFilter && (
        <div className="filter-bar">
          <span className="lbl">Filter</span>
          <span className="filter-tag">
            orchestration={orchFilter}
            <button onClick={clearOrchFilter} title="Clear">
              <X style={{ width: 10, height: 10 }} />
            </button>
          </span>
          <span className="muted" style={{ fontSize: 12 }}>· {filtered.length} match</span>
        </div>
      )}

      <div className="row gap-sm" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        {ALL_STATUSES.map((s) => {
          const active = statusFilter === s;
          const n = counts[s] ?? 0;
          return (
            <button
              key={s}
              className="btn sm"
              onClick={() => setStatusFilter(s)}
              style={{
                borderColor: active ? "var(--ink)" : "var(--line)",
                background: active ? "var(--ink)" : "var(--bg)",
                color: active ? "var(--bg)" : "var(--ink-1)",
              }}
            >
              {s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)}
              <span className="mono tabular" style={{ opacity: 0.7, fontSize: 11 }}>{n}</span>
            </button>
          );
        })}
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <table className="tbl" style={{ minWidth: 1000 }}>
          <thead>
            <tr>
              <th style={{ width: "30%" }}>Orchestration</th>
              <th style={{ width: 130 }}>Status</th>
              <th style={{ width: "20%" }}>Trigger</th>
              <th style={{ width: 160 }}>Started</th>
              <th style={{ width: 100 }}>Duration</th>
              <th>Run ID</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: 40, color: "var(--ink-2)" }}>
                  No runs match these filters.
                </td>
              </tr>
            )}
            {filtered.map((r) => {
              const orch = r.orchestrations;
              return (
                <tr key={r.id} onClick={() => router.push(`/runs/${r.id}`)}>
                  <td>
                    <span className="mono" style={{ color: "var(--ink)", fontSize: 12.5 }}>
                      {orch?.name ?? "-"}
                    </span>
                    {orch?.version != null && (
                      <span className="muted mono" style={{ fontSize: 11, marginLeft: 6 }}>
                        v{orch.version}
                      </span>
                    )}
                  </td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>
                    <TriggerChip trigger={{ kind: r.triggered_by ?? "-", label: r.triggered_by }} />
                  </td>
                  <td className="mono tabular" style={{ color: "var(--ink-2)", fontSize: 12 }}>
                    {fmtAbs(r.created_at)}
                  </td>
                  <td className="mono tabular" style={{ color: "var(--ink-1)", fontSize: 12 }}>
                    {fmtDuration(r.started_at, r.ended_at)}
                  </td>
                  <td><MonoId id={r.id} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
