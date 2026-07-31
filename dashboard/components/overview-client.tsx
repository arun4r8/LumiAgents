"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { OverviewRealtime } from "@/components/overview-realtime";
import {
  RefreshCw,
  Sparkles,
  CheckCircle,
  BarChart2,
  Check,
  X,
  ArrowRight,
  AlertTriangle,
  Clock,
} from "lucide-react";
import { StatusBadge, fmtTimeAgo, fmtExpiry, fmtAbs } from "@/components/lumi";
import { WindowToggle } from "@/components/window-toggle";
import {
  aggregateByAgent,
  daysFor,
  fmtTokens,
  fmtUsd,
  type SpendRow,
  type SpendWindow,
} from "@/lib/spend";
import { agentColor } from "@/lib/agent-style";

// ── types ─────────────────────────────────────────────────────────────

interface Run {
  id: string;
  status: string;
  orchestration_id: string | null;
  triggered_by: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  orchestrations: { name: string } | null;
}

interface Approval {
  id: string;
  prompt: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  run_id: string | null;
  runs: { id: string; orchestrations: { name: string } | null } | null;
}

interface Orchestration {
  id: string;
  name: string;
  version: string | number;
  is_active: boolean;
  cron: string | null;
}

interface RecentStep {
  id: string;
  step_name: string;
  step_type: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  runs: { id: string; orchestrations: { name: string } | null } | null;
}

interface OverviewClientProps {
  runs: Run[];
  approvals: Approval[];
  orchestrations: Orchestration[];
  recentSteps: RecentStep[];
  decideApproval: (id: string, approved: boolean, notes: string) => Promise<void>;
}

// Spend pricing lives in lib/llm-pricing and aggregation/formatting in lib/spend
// (shared with the Infrastructure tab's LLM Cost KPI so the two surfaces
// reconcile). Agent colors live in lib/agent-style.

// ── Root component ────────────────────────────────────────────────────

export default function OverviewClient({
  runs: initialRuns,
  approvals,
  orchestrations,
  recentSteps,
  decideApproval,
}: OverviewClientProps) {
  const router = useRouter();
  const [now, setNow] = useState(Date.now());
  const [runs, setRuns] = useState<Run[]>(initialRuns);
  const [realtimeConnected, setRealtimeConnected] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const handleRunChange = useCallback(
    (incoming: { id: string; status: string }) => {
      setRealtimeConnected(true);
      setRuns((prev) => {
        const idx = prev.findIndex((r) => r.id === incoming.id);
        if (idx === -1) {
          // New run arrived via INSERT; we don't have full data, so just
          // trigger a router refresh to pull the full row from the server.
          router.refresh();
          return prev;
        }
        // UPDATE: patch just the status field in local state
        const next = [...prev];
        next[idx] = { ...next[idx], status: incoming.status };
        return next;
      });
    },
    [router]
  );

  const pending = approvals.filter((a) => a.status === "pending");
  const expiringSoon = pending.filter((a) => {
    if (!a.expires_at) return false;
    return new Date(a.expires_at).getTime() - Date.now() < 30 * 60_000;
  }).length;

  const live = runs.filter((r) => r.status === "running").length;
  const blocked = runs.filter((r) => r.status === "paused").length;
  const recentRuns = runs.slice(0, 50);
  const completed = recentRuns.filter((r) => r.status === "completed").length;
  const failed = recentRuns.filter((r) => r.status === "failed").length;
  const successRate =
    completed + failed > 0 ? Math.round((100 * completed) / (completed + failed)) : 100;

  function navigate(path: string) {
    router.push(path);
  }

  return (
    <div className="page view-fade">
      {/* Headless Realtime subscription */}
      <OverviewRealtime onRunChange={handleRunChange} />

      {/* Page header */}
      <div className="page-h">
        <div>
          <h1>Overview</h1>
          <div className="sub">
            <span className="row gap-sm" style={{ display: "inline-flex", alignItems: "center" }}>
              <span className="live-dot" />
              Live · {fmtClock(now)} UTC
              {realtimeConnected && (
                <span
                  className="chip ok"
                  style={{ fontSize: 10.5, padding: "1px 6px", marginLeft: 4 }}
                  title="Supabase Realtime connected"
                >
                  Realtime
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="row gap-sm">
          <button className="btn sm" onClick={() => router.refresh()}>
            <RefreshCw /> Refresh
          </button>
          <button className="btn primary sm" onClick={() => navigate("/approvals")}>
            Approvals ({pending.length}) <ArrowRight />
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="kpis">
        <KpiCard
          tone={pending.length > 0 ? (expiringSoon > 0 ? "err" : "warn") : "ok"}
          label="Awaiting approval"
          value={pending.length}
          unit="decisions"
          sub={
            expiringSoon > 0
              ? `${expiringSoon} expiring within 30m`
              : pending.length === 0
              ? "No pending approvals"
              : "All within window"
          }
          onClick={() => navigate("/approvals")}
          icon={<CheckCircle />}
        />
        <KpiCard
          tone="info"
          label="Running now"
          value={live}
          unit="agents live"
          sub={`${blocked} blocked`}
          onClick={() => navigate("/runs")}
          icon={<Sparkles />}
          live
        />
        <KpiCard
          tone={successRate >= 95 ? "ok" : successRate >= 80 ? "warn" : "err"}
          label="Success rate · 30d"
          value={`${successRate}%`}
          unit=""
          sub={`${completed} ok · ${failed} failed · ${recentRuns.length} total`}
          icon={<Check />}
          onClick={() => navigate("/runs")}
        />
        <KpiCard
          tone="muted"
          label="Orchestrations"
          value={orchestrations.filter((o) => o.is_active).length}
          unit="active"
          sub={`${orchestrations.length} total in catalogue`}
          icon={<BarChart2 />}
          onClick={() => navigate("/orchestrations")}
        />
      </div>

      {/* Grid */}
      <div className="ovr-grid">
        {/* Fleet */}
        <section className="card pad">
          <div className="sec-h">
            <div className="row gap-sm">
              <h3>Fleet</h3>
              <span className="chip muted mono">{orchestrations.length} agents</span>
            </div>
            <button className="btn ghost sm" onClick={() => navigate("/orchestrations")}>
              Orchestrations <ArrowRight style={{ width: 12, height: 12 }} />
            </button>
          </div>
          <div className="fleet">
            {orchestrations.map((o) => (
              <FleetTile key={o.id} o={o} runs={runs} navigate={navigate} />
            ))}
          </div>
        </section>

        {/* Activity stream */}
        <section className="card pad">
          <div className="sec-h">
            <div className="row gap-sm">
              <h3>Activity</h3>
              <span className="chip ok">
                <span className="live-dot" style={{ background: "var(--ok)", marginRight: 2 }} /> live
              </span>
            </div>
            <button className="btn ghost sm" onClick={() => navigate("/runs")}>
              All runs <ArrowRight style={{ width: 12, height: 12 }} />
            </button>
          </div>
          <ActivityStream steps={recentSteps} />
        </section>

        {/* What needs me */}
        <section className="card pad">
          <div className="sec-h">
            <div className="row gap-sm">
              <h3>What needs you</h3>
              {pending.length > 0 && (
                <span className="chip warn">{pending.length} pending</span>
              )}
            </div>
            {pending.length > 2 && (
              <button className="btn ghost sm" onClick={() => navigate("/approvals")}>
                See all <ArrowRight style={{ width: 12, height: 12 }} />
              </button>
            )}
          </div>
          {pending.length === 0 ? (
            <div className="empty" style={{ padding: 30, border: "none" }}>
              <div className="ico"><Check /></div>
              <h4>Nothing blocking.</h4>
              <p>All agents are running unattended.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[...pending]
                .sort((a, b) => {
                  const ta = a.expires_at ? new Date(a.expires_at).getTime() : Infinity;
                  const tb = b.expires_at ? new Date(b.expires_at).getTime() : Infinity;
                  return ta - tb;
                })
                .slice(0, 3)
                .map((a) => (
                  <MiniApproval
                    key={a.id}
                    a={a}
                    decide={decideApproval}
                    navigate={navigate}
                  />
                ))}
            </div>
          )}
        </section>

        <section className="card pad">
          <div className="sec-h">
            <h3>Throughput · last 24h</h3>
            <div className="muted mono" style={{ fontSize: 11.5 }}>{recentRuns.length} runs</div>
          </div>
          <ThroughputChart runs={runs} />
        </section>

        {/* SLA board */}
        <section className="card pad">
          <div className="sec-h">
            <h3>Approval SLA</h3>
          </div>
          <SlaBoard approvals={approvals} />
        </section>

        {/* Spend by agent */}
        <SpendByAgent />
      </div>
    </div>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────

function KpiCard({
  tone = "muted",
  label,
  value,
  unit,
  sub,
  icon,
  onClick,
  live,
}: {
  tone?: string;
  label: string;
  value: string | number;
  unit: string;
  sub: string;
  icon: React.ReactNode;
  onClick?: () => void;
  live?: boolean;
}) {
  return (
    <div
      className={`kpi tone-${tone}${onClick ? " clickable" : ""}`}
      onClick={onClick}
    >
      <div className="kpi-h">
        <span className="kpi-ico">{icon}</span>
        <span className="kpi-lbl">{label}</span>
        {live && <span className="live-dot" style={{ marginLeft: "auto" }} />}
      </div>
      <div className="kpi-v">
        <span className="kpi-num">{value}</span>
        {unit && <span className="kpi-unit">{unit}</span>}
      </div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

// ── Fleet tile ────────────────────────────────────────────────────────

function FleetTile({
  o,
  runs,
  navigate,
}: {
  o: Orchestration;
  runs: Run[];
  navigate: (p: string) => void;
}) {
  const myRuns = runs.filter((r) => r.orchestrations?.name === o.name);
  const live = myRuns.find((r) => r.status === "running");
  const paused = myRuns.find((r) => r.status === "paused");
  const lastFail = myRuns.find((r) => r.status === "failed");
  const lastOk = myRuns.find((r) => r.status === "completed");

  let state = "idle";
  let tone = "muted";
  if (!o.is_active) { state = "idle"; tone = "muted"; }
  else if (live) { state = "running"; tone = "info"; }
  else if (paused) { state = "blocked"; tone = "warn"; }
  else if (
    lastFail &&
    (!lastOk || lastFail.created_at > lastOk.created_at)
  ) { state = "failing"; tone = "err"; }
  else { state = "idle"; tone = "ok"; }

  return (
    <div
      className={`fleet-tile tone-${tone}`}
      onClick={() => navigate(`/runs?orchestration=${encodeURIComponent(o.name)}`)}
    >
      <div className="ft-h">
        <span className="ft-name">{o.name}</span>
        <span className={`ft-state ${state}`}>
          <span className="dot" />{state}
        </span>
      </div>
      <div className="ft-meta">
        <span className="chip muted mono" style={{ height: 17, fontSize: 10.5 }}>v{o.version}</span>
        {o.cron && (
          <span className="chip muted">
            <Clock style={{ width: 10, height: 10 }} /> {o.cron}
          </span>
        )}
      </div>
      <div className="ft-foot mono">
        <span>{myRuns.length} runs</span>
        {!o.is_active && <span className="chip muted" style={{ marginLeft: "auto" }}>paused</span>}
      </div>
    </div>
  );
}

// ── Activity stream ───────────────────────────────────────────────────

function ActivityStream({ steps }: { steps: RecentStep[] }) {
  if (steps.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12, padding: "20px 0" }}>
        No recent activity.
      </div>
    );
  }
  return (
    <div className="stream">
      {steps.map((s, i) => {
        const kind =
          s.status === "failed" ? "err"
          : s.status === "completed" ? "ok"
          : s.status === "running" ? "info"
          : "info";
        const orch = s.runs?.orchestrations?.name ?? "-";
        const age = s.started_at
          ? Math.floor((Date.now() - new Date(s.started_at).getTime()) / 1000)
          : null;
        const ageStr = age == null ? "?" : age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`;

        return (
          <div key={s.id} className={`stream-row${i === 0 ? " fresh" : ""}`}>
            <span className={`stream-dot ${kind}`} />
            <span className="stream-time">{ageStr}</span>
            <span className="stream-agent">{orch}</span>
            <span className="stream-step">{s.step_name}</span>
            <span className="stream-text">{s.status}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Mini approval ─────────────────────────────────────────────────────

function MiniApproval({
  a,
  decide,
  navigate,
}: {
  a: Approval;
  decide: (id: string, approved: boolean, notes: string) => Promise<void>;
  navigate: (p: string) => void;
}) {
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const expiring = a.expires_at
    ? new Date(a.expires_at).getTime() - Date.now() < 30 * 60_000
    : false;
  const urgent = a.expires_at
    ? new Date(a.expires_at).getTime() - Date.now() < 2 * 60 * 60_000
    : false;

  const submit = async (kind: "approve" | "reject") => {
    if (pending) return;
    setPending(kind);
    try {
      await decide(a.id, kind === "approve", "");
    } finally {
      setPending(null);
    }
  };

  const orchName = a.runs?.orchestrations?.name ?? "-";

  return (
    <div className={`mini-ap${expiring ? " expiring" : urgent ? " urgent" : ""}`}>
      <div className="mini-ap-h">
        <span className="mono" style={{ fontSize: 12.5, color: "var(--ink)" }}>{orchName}</span>
        <span className="muted mono" style={{ fontSize: 11.5, marginLeft: "auto" }}>
          {fmtExpiry(a.expires_at)}
        </span>
      </div>
      <div className="mini-ap-prompt" style={{
        overflow: "hidden",
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
      }}>
        {a.prompt}
      </div>
      <div className="row gap-sm">
        <button className="btn success sm" disabled={!!pending} onClick={() => submit("approve")}>
          <Check style={{ width: 11, height: 11 }} />
          {pending === "approve" ? "Approving…" : "Approve"}
        </button>
        <button className="btn danger-out sm" disabled={!!pending} onClick={() => submit("reject")}>
          <X style={{ width: 11, height: 11 }} />
          {pending === "reject" ? "Rejecting…" : "Reject"}
        </button>
        <button
          className="btn ghost sm"
          style={{ marginLeft: "auto" }}
          onClick={() => navigate(a.run_id ? `/runs/${a.run_id}` : "/approvals")}
        >
          Open run <ArrowRight style={{ width: 11, height: 11 }} />
        </button>
      </div>
    </div>
  );
}

// ── Throughput chart ──────────────────────────────────────────────────

function ThroughputChart({ runs }: { runs: Run[] }) {
  const buckets = useMemo(() => {
    const now = Date.now();
    const out: { completed: number; failed: number; paused: number }[] = Array.from(
      { length: 24 },
      () => ({ completed: 0, failed: 0, paused: 0 })
    );
    for (const r of runs) {
      const age = now - new Date(r.created_at).getTime();
      const h = Math.floor(age / 3_600_000);
      if (h >= 24) continue;
      const bucket = 23 - h;
      if (r.status === "completed") out[bucket].completed++;
      else if (r.status === "failed") out[bucket].failed++;
      else if (r.status === "paused") out[bucket].paused++;
    }
    return out;
  }, [runs]);

  const max = Math.max(...buckets.map((b) => b.completed + b.failed + b.paused), 1);

  return (
    <>
      <div className="thru">
        {buckets.map((b, i) => {
          const pct = (n: number) => `${(n / max) * 100}%`;
          return (
            <div key={i} className="thru-bar">
              <div className="seg failed" style={{ height: pct(b.failed) }} />
              <div className="seg paused" style={{ height: pct(b.paused) }} />
              <div className="seg ok" style={{ height: pct(b.completed) }} />
            </div>
          );
        })}
      </div>
      <div className="thru-axis mono">
        <span>-24h</span><span>-18h</span><span>-12h</span><span>-6h</span><span>now</span>
      </div>
      <div className="legend">
        <span><span className="sw ok" /> completed</span>
        <span><span className="sw paused" /> paused</span>
        <span><span className="sw failed" /> failed</span>
      </div>
    </>
  );
}

// ── SLA board ─────────────────────────────────────────────────────────

function SlaBoard({ approvals }: { approvals: Approval[] }) {
  const decided = approvals.filter((a) => a.status !== "pending");
  const pending = approvals.filter((a) => a.status === "pending");

  const stats = [
    {
      label: "Pending decisions",
      value: pending.length.toString(),
      tone: pending.length > 5 ? "err" : pending.length > 0 ? "warn" : "ok",
    },
    {
      label: "Total (30d)",
      value: approvals.length.toString(),
      tone: "muted",
    },
    {
      label: "Decided",
      value: decided.length.toString(),
      tone: "ok",
    },
    {
      label: "Approval rate",
      value: decided.length > 0
        ? `${Math.round(
            (100 * decided.filter((a) => a.status === "approved").length) / decided.length
          )}%`
        : "-",
      tone: "ok",
    },
  ];

  return (
    <div className="sla">
      {stats.map((s) => (
        <div key={s.label} className="sla-cell">
          <div className={`sla-v tone-${s.tone}`}>{s.value}</div>
          <div className="sla-l">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

// ── Spend by agent ────────────────────────────────────────────────────

function SpendByAgent() {
  const [win, setWin] = useState<SpendWindow>("30d");
  const [rows, setRows] = useState<SpendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/spend?days=${daysFor(win)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as SpendRow[];
      })
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [win]);

  const winLabel = win === "24h" ? "24h" : win === "7d" ? "7d" : "30d";
  const winCaption = win === "24h" ? "last 24h" : win === "7d" ? "last 7 days" : "last 30 days";

  const { agents, totalCost, totalTokens } = useMemo(
    () => aggregateByAgent(rows),
    [rows]
  );

  const maxCost = Math.max(...agents.map((a) => a.cost), 1e-9);

  return (
    <section className="card pad">
      <div className="sec-h">
        <h3>Spend by agent</h3>
        <div className="row gap-sm" style={{ alignItems: "center" }}>
          <div className="muted mono" style={{ fontSize: 11.5 }}>{winCaption}</div>
          <WindowToggle value={win} onChange={setWin} />
        </div>
      </div>

      {loading ? (
        <div className="muted" style={{ fontSize: 12, padding: "20px 0" }}>
          Loading spend…
        </div>
      ) : error ? (
        <div style={{ fontSize: 12, padding: "20px 0", color: "var(--err)" }}>
          {error}
        </div>
      ) : agents.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, padding: "20px 0" }}>
          No agent spend recorded in this window.
        </div>
      ) : (
        <div className="spend">
          <div className="spend-tot">
            <div className="spend-tot-cell">
              <div className="spend-tot-v" style={{ fontVariantNumeric: "tabular-nums" }}>
                {fmtUsd(totalCost)}
              </div>
              <div className="spend-tot-l">estimated · {winLabel}</div>
            </div>
            <div className="spend-tot-cell">
              <div className="spend-tot-v" style={{ fontVariantNumeric: "tabular-nums" }}>
                {fmtTokens(totalTokens)}
              </div>
              <div className="spend-tot-l">total tokens</div>
            </div>
          </div>

          <div className="spend-bars">
            {agents.map((a) => (
              <div key={a.agent} className="spend-row">
                <div className="spend-row-h">
                  <span className="spend-agent" style={{ color: agentColor(a.agent) }}>
                    <span className="spend-dot" style={{ background: agentColor(a.agent) }} />
                    {a.agent}
                  </span>
                  <span className="spend-cost mono" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {fmtUsd(a.cost)}
                  </span>
                  <span
                    className="spend-tok mono muted"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {fmtTokens(a.tokens)}
                  </span>
                </div>
                <div className="spend-track">
                  <div
                    className="spend-fill"
                    style={{
                      width: `${(a.cost / maxCost) * 100}%`,
                      background: agentColor(a.agent),
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="spend-note muted">
            Estimated — prices are approximate model list rates and may not reflect billing.
          </div>
        </div>
      )}
    </section>
  );
}

// ── Helper ────────────────────────────────────────────────────────────

function fmtClock(ms: number) {
  const d = new Date(ms);
  return (
    String(d.getUTCHours()).padStart(2, "0") +
    ":" +
    String(d.getUTCMinutes()).padStart(2, "0") +
    ":" +
    String(d.getUTCSeconds()).padStart(2, "0")
  );
}
