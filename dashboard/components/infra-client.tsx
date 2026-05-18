"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  Server,
  Activity,
  Terminal,
  Key,
  RefreshCw,
  Loader2,
  Play,
  Square,
  Trash2,
  Plus,
  AlertTriangle,
  Check,
  X,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface CfInvocationBucket {
  sum: { requests: number; errors: number };
  quantiles: { cpuTimeP50: number; cpuTimeP99: number };
  dimensions: { datetime: string; status: string };
}

interface MetricsData {
  data?: {
    viewer?: {
      accounts?: Array<{
        workersInvocationsAdaptive?: CfInvocationBucket[];
      }>;
    };
  };
  error?: string;
}

interface Deployment {
  id: string;
  number?: number;
  metadata?: {
    created_on?: string;
    source?: string;
    author_email?: string;
  };
  resources?: {
    script?: { etag?: string };
  };
  is_latest?: boolean;
}

interface CfSecret {
  name: string;
  type?: string;
  created_on?: string;
}

interface TailMessage {
  outcome: "ok" | "exception" | "canceled" | "exceededCpu";
  scriptName?: string;
  logs?: Array<{
    message: string[];
    level: "log" | "error" | "warn";
    timestamp: number;
  }>;
  exceptions?: Array<{
    name: string;
    message: string;
    timestamp: number;
  }>;
  eventTimestamp?: number;
}

interface LogLine {
  id: number;
  ts: number;
  outcome: string;
  level: string;
  message: string;
}

// ── Setup card shown when CF creds missing ─────────────────────────────────────

function SetupCard() {
  return (
    <div
      className="card pad"
      style={{ maxWidth: 560, margin: "40px auto" }}
    >
      <div className="sec-h" style={{ marginBottom: 16 }}>
        <div className="row gap-sm">
          <AlertTriangle style={{ color: "var(--warn)", width: 18, height: 18 }} />
          <h3>Cloudflare credentials not configured</h3>
        </div>
      </div>
      <p style={{ fontSize: 13.5, color: "var(--ink-2)", marginBottom: 18, lineHeight: 1.6 }}>
        Set these environment variables to enable infrastructure management:
      </p>
      <div
        className="mono"
        style={{
          background: "var(--surface-2, var(--bg-2, #111))",
          border: "1px solid var(--line)",
          borderRadius: 8,
          padding: "14px 16px",
          fontSize: 12.5,
          lineHeight: 2,
          color: "var(--ink)",
        }}
      >
        <div>
          <span style={{ color: "var(--ok)" }}>CLOUDFLARE_ACCOUNT_ID</span>
          {"   "}— your CF account ID
        </div>
        <div>
          <span style={{ color: "var(--ok)" }}>CLOUDFLARE_API_TOKEN</span>
          {"    "}— API token with Workers Scripts Read + Edit permissions
        </div>
        <div>
          <span style={{ color: "var(--ok)" }}>CF_WORKER_SCRIPT_NAME</span>
          {"  "}— defaults to &quot;lumiagents-runtime&quot;
        </div>
      </div>
      <p
        style={{
          fontSize: 12,
          color: "var(--ink-3)",
          marginTop: 14,
        }}
        className="mono"
      >
        Add to <span style={{ color: "var(--ink)" }}>dashboard/.env.local</span> for local dev.
      </p>
    </div>
  );
}

// ── Metrics tab ────────────────────────────────────────────────────────────────

interface UsageData {
  requestsToday: number;
  workersCount: number;
  plan: "free" | "paid";
  limits: { requestsPerDay: number; workersMax: number | null };
}

interface RunStats {
  total: number;
  succeeded: number;
  failed: number;
  cronTriggered: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
}

function formatCost(usd: number): string {
  if (usd < 0.005) return "< $0.01";
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

function MetricsTab() {
  const [raw, setRaw] = useState<MetricsData | null>(null);
  const [runStats, setRunStats] = useState<RunStats | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missingCreds, setMissingCreds] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfRes, runsRes, usageRes] = await Promise.all([
        fetch("/api/cf/metrics"),
        fetch("/api/runs/stats"),
        fetch("/api/cf/usage"),
      ]);
      if (cfRes.status === 503) {
        setMissingCreds(true);
        return;
      }
      if (!cfRes.ok) {
        const body = (await cfRes.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${cfRes.status}`);
      }
      setRaw((await cfRes.json()) as MetricsData);
      if (runsRes.ok) setRunStats((await runsRes.json()) as RunStats);
      if (usageRes.ok) setUsage((await usageRes.json()) as UsageData);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // All hooks must be called before any conditional return.
  const buckets: CfInvocationBucket[] =
    raw?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  const hourlyBuckets = useMemo(() => buildHourlyBuckets(buckets), [buckets]);
  const maxBar = Math.max(...hourlyBuckets.map((b) => b.requests + b.errors), 1);

  const p50Values = buckets.map((b) => b.quantiles?.cpuTimeP50 ?? 0).filter(Boolean);
  const p99Values = buckets.map((b) => b.quantiles?.cpuTimeP99 ?? 0).filter(Boolean);
  const avgP50 =
    p50Values.length > 0
      ? Math.round(p50Values.reduce((s, v) => s + v, 0) / p50Values.length)
      : 0;
  const avgP99 =
    p99Values.length > 0
      ? Math.round(p99Values.reduce((s, v) => s + v, 0) / p99Values.length)
      : 0;

  if (missingCreds) return <SetupCard />;

  if (loading) {
    return (
      <div className="row gap-sm" style={{ padding: "40px 0", justifyContent: "center", color: "var(--ink-3)" }}>
        <Loader2 style={{ width: 18, height: 18 }} className="spin" />
        <span>Loading metrics…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card pad" style={{ color: "var(--err)" }}>
        <AlertTriangle style={{ width: 16, height: 16 }} /> {error}
      </div>
    );
  }

  const reqPct = usage
    ? Math.min(100, (usage.requestsToday / usage.limits.requestsPerDay) * 100)
    : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* KPI strip — orchestration run stats */}
      <div className="kpis">
        <MetricKpi label="Total Runs · 24h" value={(runStats?.total ?? 0).toLocaleString()} tone="info" />
        <MetricKpi label="Succeeded" value={(runStats?.succeeded ?? 0).toLocaleString()} tone={runStats && runStats.succeeded > 0 ? "ok" : "muted"} />
        <MetricKpi label="Failed" value={(runStats?.failed ?? 0).toLocaleString()} tone={runStats && runStats.failed > 0 ? "err" : "ok"} />
        <MetricKpi label="Cron-triggered" value={(runStats?.cronTriggered ?? 0).toLocaleString()} tone="muted" />
        <MetricKpi
          label="LLM Cost · 24h"
          value={runStats ? formatCost(runStats.estimatedCostUsd) : "—"}
          tone="muted"
          subLabel={runStats ? `${((runStats.totalInputTokens + runStats.totalOutputTokens) / 1000).toFixed(1)}k tokens` : undefined}
        />
        <MetricKpi label="CPU P50 (avg)" value={`${avgP50} µs`} tone="muted" />
        <MetricKpi label="CPU P99 (avg)" value={`${avgP99} µs`} tone={avgP99 > 50000 ? "warn" : "muted"} />
      </div>

      {/* Plan usage */}
      {usage && (
        <section className="card pad">
          <div className="sec-h" style={{ marginBottom: 16 }}>
            <h3>Plan Usage</h3>
            <span className="chip muted mono" style={{ fontSize: 11 }}>
              Workers {usage.plan === "paid" ? "Paid" : "Free"}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Daily requests bar */}
            <div>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                <span style={{ color: "var(--ink-2)" }}>Requests today</span>
                <span className="mono" style={{ fontSize: 12.5 }}>
                  {usage.requestsToday.toLocaleString()}
                  <span style={{ color: "var(--ink-3)" }}>
                    {" "}/ {(usage.limits.requestsPerDay / 1_000_000).toFixed(0)}M
                  </span>
                </span>
              </div>
              <div style={{
                height: 8,
                borderRadius: 4,
                background: "var(--line)",
                overflow: "hidden",
              }}>
                <div style={{
                  height: "100%",
                  width: `${reqPct}%`,
                  borderRadius: 4,
                  background: reqPct > 90
                    ? "var(--err)"
                    : reqPct > 70
                    ? "var(--warn)"
                    : "var(--ok)",
                  transition: "width 0.4s ease",
                }} />
              </div>
              <div className="mono muted" style={{ fontSize: 11, marginTop: 4, textAlign: "right" }}>
                {reqPct.toFixed(1)}% of daily limit
              </div>
            </div>
            {/* Workers count */}
            <div className="row" style={{ justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ color: "var(--ink-2)" }}>Workers deployed</span>
              <span className="mono" style={{ fontSize: 12.5 }}>
                {usage.workersCount}
                {usage.limits.workersMax !== null && (
                  <span style={{ color: "var(--ink-3)" }}> / {usage.limits.workersMax}</span>
                )}
              </span>
            </div>
          </div>
        </section>
      )}

      {/* Bar chart */}
      <section className="card pad">
        <div className="sec-h" style={{ marginBottom: 16 }}>
          <h3>Requests · last 24h</h3>
          <button className="btn ghost sm" onClick={load}>
            <RefreshCw style={{ width: 12, height: 12 }} /> Refresh
          </button>
        </div>
        {buckets.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, padding: "20px 0" }}>
            No invocation data for this script in the last 24 hours.
          </div>
        ) : (
          <>
            <div className="thru" style={{ height: 100 }}>
              {hourlyBuckets.map((b, i) => {
                const pctOk = (b.requests / maxBar) * 100;
                const pctErr = (b.errors / maxBar) * 100;
                return (
                  <div key={i} className="thru-bar" title={`${b.requests} req · ${b.errors} err`}>
                    <div className="seg failed" style={{ height: `${pctErr}%` }} />
                    <div className="seg ok" style={{ height: `${pctOk}%` }} />
                  </div>
                );
              })}
            </div>
            <div className="thru-axis mono">
              <span>-24h</span>
              <span>-18h</span>
              <span>-12h</span>
              <span>-6h</span>
              <span>now</span>
            </div>
            <div className="legend">
              <span><span className="sw ok" /> requests</span>
              <span><span className="sw failed" /> errors</span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function MetricKpi({
  label,
  value,
  tone,
  subLabel,
}: {
  label: string;
  value: string;
  tone: string;
  subLabel?: string;
}) {
  return (
    <div className={`kpi tone-${tone}`}>
      <div className="kpi-h">
        <span className="kpi-lbl">{label}</span>
      </div>
      <div className="kpi-v">
        <span className="kpi-num" style={{ fontSize: 22 }}>{value}</span>
        {subLabel && (
          <span style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2, display: "block" }}>
            {subLabel}
          </span>
        )}
      </div>
    </div>
  );
}

function buildHourlyBuckets(
  buckets: CfInvocationBucket[]
): { requests: number; errors: number }[] {
  const out: { requests: number; errors: number }[] = Array.from({ length: 24 }, () => ({
    requests: 0,
    errors: 0,
  }));
  const now = Date.now();
  for (const b of buckets) {
    if (!b.dimensions?.datetime) continue;
    const ts = new Date(b.dimensions.datetime).getTime();
    const ageH = Math.floor((now - ts) / 3_600_000);
    if (ageH >= 24 || ageH < 0) continue;
    const idx = 23 - ageH;
    out[idx].requests += b.sum?.requests ?? 0;
    out[idx].errors += b.sum?.errors ?? 0;
  }
  return out;
}

// ── Logs tab ───────────────────────────────────────────────────────────────────

let logIdCounter = 0;

function LogsTab() {
  const [streaming, setStreaming] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [tailId, setTailId] = useState<string | null>(null);
  const [missingCreds, setMissingCreds] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const stopStreaming = useCallback(async (id: string | null) => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStreaming(false);
    setStatusMsg(null);
    if (id) {
      try {
        await fetch("/api/cf/tail", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tailId: id }),
        });
      } catch {
        // best-effort cleanup
      }
      setTailId(null);
    }
  }, []);

  const startStreaming = useCallback(async () => {
    setStatusMsg("Creating tail session…");
    try {
      const res = await fetch("/api/cf/tail", { method: "POST" });
      if (res.status === 503) {
        setMissingCreds(true);
        setStatusMsg(null);
        return;
      }
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setStatusMsg(`Error: ${body.error ?? res.status}`);
        return;
      }
      const tail = (await res.json()) as { id: string; url: string; expires_at: string };
      setTailId(tail.id);
      setStreaming(true);
      setStatusMsg("Connecting WebSocket…");

      const ws = new WebSocket(tail.url);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatusMsg("Streaming live logs");
      };

      ws.onmessage = (event: MessageEvent) => {
        let msg: TailMessage;
        try {
          msg = JSON.parse(event.data as string) as TailMessage;
        } catch {
          return;
        }

        const newLines: LogLine[] = [];

        // Add log entries
        if (msg.logs) {
          for (const log of msg.logs) {
            const text = log.message.join(" ");
            newLines.push({
              id: ++logIdCounter,
              ts: log.timestamp,
              outcome: msg.outcome ?? "ok",
              level: log.level,
              message: text,
            });
          }
        }

        // Add exception entries
        if (msg.exceptions) {
          for (const ex of msg.exceptions) {
            newLines.push({
              id: ++logIdCounter,
              ts: ex.timestamp ?? msg.eventTimestamp ?? Date.now(),
              outcome: "exception",
              level: "error",
              message: `${ex.name}: ${ex.message}`,
            });
          }
        }

        // If no logs or exceptions, still note the invocation
        if (newLines.length === 0 && msg.eventTimestamp) {
          newLines.push({
            id: ++logIdCounter,
            ts: msg.eventTimestamp,
            outcome: msg.outcome ?? "ok",
            level: "log",
            message: `[invocation] outcome=${msg.outcome}`,
          });
        }

        setLines((prev) => {
          const next = [...prev, ...newLines];
          return next.length > 500 ? next.slice(next.length - 500) : next;
        });
      };

      ws.onerror = () => {
        setStatusMsg("WebSocket error — check browser console");
      };

      ws.onclose = () => {
        if (streaming) {
          setStatusMsg("Connection closed");
        }
        setStreaming(false);
        wsRef.current = null;
      };
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : String(e));
      setStreaming(false);
    }
  }, [streaming]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  if (missingCreds) return <SetupCard />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Controls */}
      <div className="card pad">
        <div className="row gap-sm" style={{ flexWrap: "wrap" }}>
          {!streaming ? (
            <button className="btn primary sm" onClick={startStreaming}>
              <Play style={{ width: 13, height: 13 }} /> Start streaming
            </button>
          ) : (
            <button className="btn danger-out sm" onClick={() => void stopStreaming(tailId)}>
              <Square style={{ width: 13, height: 13 }} /> Stop streaming
            </button>
          )}
          <button
            className="btn ghost sm"
            onClick={() => setLines([])}
            disabled={lines.length === 0}
          >
            <X style={{ width: 12, height: 12 }} /> Clear
          </button>
          {statusMsg && (
            <span
              className="mono muted"
              style={{ fontSize: 12, marginLeft: "auto", alignSelf: "center" }}
            >
              {streaming && (
                <span
                  className="live-dot"
                  style={{ display: "inline-block", marginRight: 6 }}
                />
              )}
              {statusMsg}
            </span>
          )}
          <span className="chip muted mono" style={{ marginLeft: "auto", fontSize: 11 }}>
            {lines.length} lines
          </span>
        </div>
      </div>

      {/* Log output */}
      <div
        className="card mono"
        style={{
          minHeight: 400,
          maxHeight: 600,
          overflowY: "auto",
          padding: "12px 16px",
          fontSize: 12,
          lineHeight: 1.7,
          background: "var(--surface-2, #0d0d0d)",
          borderRadius: 10,
        }}
      >
        {lines.length === 0 ? (
          <div className="muted" style={{ padding: "20px 0", fontSize: 12 }}>
            {streaming
              ? "Waiting for invocations…"
              : 'Press “Start streaming” to tail live Worker logs.'}
          </div>
        ) : (
          lines.map((line) => (
            <div
              key={line.id}
              style={{
                color:
                  line.level === "error" || line.outcome === "exception"
                    ? "var(--err)"
                    : line.level === "warn"
                    ? "var(--warn)"
                    : "var(--ink)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              <span style={{ color: "var(--ink-3)", marginRight: 8 }}>
                {new Date(line.ts).toISOString().replace("T", " ").slice(0, 23)}
              </span>
              <span
                style={{
                  marginRight: 8,
                  color:
                    line.outcome === "ok"
                      ? "var(--ok)"
                      : line.outcome === "exception"
                      ? "var(--err)"
                      : "var(--warn)",
                }}
              >
                [{line.outcome}]
              </span>
              {line.message}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── Deployments tab ────────────────────────────────────────────────────────────

function DeploymentsTab() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missingCreds, setMissingCreds] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cf/deployments");
      if (res.status === 503) { setMissingCreds(true); return; }
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setDeployments((await res.json()) as Deployment[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (missingCreds) return <SetupCard />;
  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorCard error={error} />;

  return (
    <section className="card pad">
      <div className="sec-h" style={{ marginBottom: 16 }}>
        <h3>Deployments</h3>
        <button className="btn ghost sm" onClick={load}>
          <RefreshCw style={{ width: 12, height: 12 }} /> Refresh
        </button>
      </div>
      {deployments.length === 0 ? (
        <div className="muted" style={{ fontSize: 13, padding: "12px 0" }}>No deployments found.</div>
      ) : (
        <table className="tbl" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>ID</th>
              <th>Created</th>
              <th>Source</th>
              <th>Author</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((d, idx) => {
              const isCurrent = d.is_latest === true || idx === 0;
              return (
                <tr key={d.id}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {d.id.slice(0, 16)}…
                  </td>
                  <td className="mono muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                    {d.metadata?.created_on
                      ? new Date(d.metadata.created_on).toLocaleString()
                      : "—"}
                  </td>
                  <td className="muted" style={{ fontSize: 12.5 }}>
                    {d.metadata?.source ?? "—"}
                  </td>
                  <td className="muted" style={{ fontSize: 12.5 }}>
                    {d.metadata?.author_email ?? "—"}
                  </td>
                  <td>
                    {isCurrent ? (
                      <span className="chip ok" style={{ fontSize: 11 }}>
                        <Check style={{ width: 11, height: 11 }} /> current
                      </span>
                    ) : (
                      <span className="chip muted" style={{ fontSize: 11 }}>
                        previous
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ── Secrets tab ────────────────────────────────────────────────────────────────

function SecretsTab() {
  const [secrets, setSecrets] = useState<CfSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missingCreds, setMissingCreds] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cf/secrets");
      if (res.status === 503) { setMissingCreds(true); return; }
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setSecrets((await res.json()) as CfSecret[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    if (!newName.trim() || !newValue.trim()) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/cf/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), text: newValue }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setSaveMsg({ ok: false, text: body.error ?? `HTTP ${res.status}` });
        return;
      }
      setSaveMsg({ ok: true, text: `Secret "${newName.trim()}" saved.` });
      setNewName("");
      setNewValue("");
      await load();
    } catch (e) {
      setSaveMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete secret "${name}"? This cannot be undone.`)) return;
    setDeletingName(name);
    try {
      const res = await fetch("/api/cf/secrets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        alert(body.error ?? `HTTP ${res.status}`);
        return;
      }
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingName(null);
    }
  };

  if (missingCreds) return <SetupCard />;
  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorCard error={error} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Warning banner */}
      <div
        className="card pad"
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          background: "color-mix(in srgb, var(--warn) 8%, transparent)",
          borderColor: "color-mix(in srgb, var(--warn) 30%, transparent)",
        }}
      >
        <AlertTriangle
          style={{ width: 16, height: 16, color: "var(--warn)", flexShrink: 0, marginTop: 2 }}
        />
        <span style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>
          <strong>Secret values are write-only</strong> — they cannot be read after creation.
          Rotating a secret overwrites it.
        </span>
      </div>

      {/* Existing secrets */}
      <section className="card pad">
        <div className="sec-h" style={{ marginBottom: 16 }}>
          <h3>Worker Secrets</h3>
          <button className="btn ghost sm" onClick={load}>
            <RefreshCw style={{ width: 12, height: 12 }} /> Refresh
          </button>
        </div>
        {secrets.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, padding: "12px 0" }}>
            No secrets configured.
          </div>
        ) : (
          <table className="tbl" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.name}>
                  <td className="mono" style={{ fontSize: 13 }}>
                    {s.name}
                  </td>
                  <td className="muted" style={{ fontSize: 12.5 }}>
                    {s.type ?? "secret_text"}
                  </td>
                  <td className="mono muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                    {s.created_on ? new Date(s.created_on).toLocaleString() : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn ghost sm"
                      style={{ color: "var(--err)" }}
                      disabled={deletingName === s.name}
                      onClick={() => void handleDelete(s.name)}
                      title={`Delete ${s.name}`}
                    >
                      {deletingName === s.name ? (
                        <Loader2 style={{ width: 13, height: 13 }} className="spin" />
                      ) : (
                        <Trash2 style={{ width: 13, height: 13 }} />
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Add / rotate secret */}
      <section className="card pad">
        <div className="sec-h" style={{ marginBottom: 16 }}>
          <h3>
            <Plus style={{ width: 15, height: 15, marginRight: 6, verticalAlign: "middle" }} />
            Add / rotate secret
          </h3>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 480 }}>
          <input
            type="text"
            className="mono"
            placeholder="SECRET_NAME"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{
              padding: "8px 12px",
              border: "1px solid var(--line)",
              borderRadius: 6,
              background: "var(--bg)",
              color: "var(--ink)",
              fontSize: 13,
              outline: "none",
            }}
          />
          <input
            type="password"
            placeholder="Secret value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            style={{
              padding: "8px 12px",
              border: "1px solid var(--line)",
              borderRadius: 6,
              background: "var(--bg)",
              color: "var(--ink)",
              fontSize: 13,
              outline: "none",
            }}
          />
          <div className="row gap-sm">
            <button
              className="btn primary sm"
              onClick={() => void handleCreate()}
              disabled={saving || !newName.trim() || !newValue.trim()}
            >
              {saving ? (
                <Loader2 style={{ width: 13, height: 13 }} className="spin" />
              ) : (
                <Key style={{ width: 13, height: 13 }} />
              )}
              {saving ? "Saving…" : "Save secret"}
            </button>
            {saveMsg && (
              <span
                style={{
                  fontSize: 12.5,
                  color: saveMsg.ok ? "var(--ok)" : "var(--err)",
                  alignSelf: "center",
                }}
              >
                {saveMsg.ok ? (
                  <Check style={{ width: 13, height: 13, marginRight: 4 }} />
                ) : (
                  <X style={{ width: 13, height: 13, marginRight: 4 }} />
                )}
                {saveMsg.text}
              </span>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

// ── Cron tab ───────────────────────────────────────────────────────────────────
// ── Shared helpers ─────────────────────────────────────────────────────────────

function LoadingSpinner() {
  return (
    <div
      className="row gap-sm"
      style={{ padding: "40px 0", justifyContent: "center", color: "var(--ink-3)" }}
    >
      <Loader2 style={{ width: 18, height: 18 }} className="spin" />
      <span>Loading…</span>
    </div>
  );
}

function ErrorCard({ error }: { error: string }) {
  return (
    <div
      className="card pad row gap-sm"
      style={{ color: "var(--err)", fontSize: 13.5 }}
    >
      <AlertTriangle style={{ width: 16, height: 16, flexShrink: 0 }} />
      {error}
    </div>
  );
}

// ── Tab definitions ────────────────────────────────────────────────────────────

type Tab = "metrics" | "logs" | "deployments" | "secrets";

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: "metrics",     label: "Metrics",     icon: <Activity style={{ width: 14, height: 14 }} /> },
  { id: "logs",        label: "Logs",        icon: <Terminal style={{ width: 14, height: 14 }} /> },
  { id: "deployments", label: "Deployments", icon: <Server style={{ width: 14, height: 14 }} /> },
  { id: "secrets",     label: "Secrets",     icon: <Key style={{ width: 14, height: 14 }} /> },
];

// ── Root component ─────────────────────────────────────────────────────────────

export function InfraClient() {
  const [tab, setTab] = useState<Tab>("metrics");

  return (
    <div className="page view-fade">
      {/* Page header */}
      <div className="page-h">
        <div>
          <h1>Infrastructure</h1>
          <div className="sub">
            Cloudflare Workers management — metrics, logs, deployments, secrets, cron
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs" style={{ marginBottom: 24 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            <span className="row gap-sm" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t.icon}
              {t.label}
            </span>
          </button>
        ))}
      </div>

      {/* Tab panels */}
      {tab === "metrics"     && <MetricsTab />}
      {tab === "logs"        && <LogsTab />}
      {tab === "deployments" && <DeploymentsTab />}
      {tab === "secrets"     && <SecretsTab />}
    </div>
  );
}
