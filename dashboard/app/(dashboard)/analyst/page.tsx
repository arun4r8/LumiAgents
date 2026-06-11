"use client";

import { useState, useRef, useCallback } from "react";
import { Send, Loader2, Upload, X, Table, ChevronDown, ChevronUp } from "lucide-react";
import { runtimeAuthHeader } from "@/lib/runtime-auth";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "";

const EXAMPLES = [
  "How many runs failed in the last 7 days, by orchestration?",
  "What's our average approval response time this month?",
  "Show me all opportunities scored 'pursue' with their agencies",
  "Top 5 contracts by obligated value",
  "Which candidates have overall_score above 80?",
];

interface AnalystResult {
  answer: string;
  sql?: string;
  rowCount?: number;
  uploadedTables?: string[];
  inputTokens: number;
  outputTokens: number;
}

interface CsvUpload {
  sessionKey: string;
  sourceName: string;
  rowCount: number;
  colNames: string[];
}

function highlightSql(sql: string): string {
  const keywords = [
    "SELECT","FROM","WHERE","GROUP BY","ORDER BY","HAVING","LIMIT","OFFSET",
    "JOIN","LEFT","RIGHT","INNER","OUTER","ON","AS","AND","OR","NOT","IN",
    "COUNT","SUM","AVG","MAX","MIN","ROUND","DISTINCT","CASE","WHEN","THEN",
    "ELSE","END","NULL","IS","INTERVAL","NOW","DATE_TRUNC","FILTER","WITH",
    "JSONB_ARRAY_ELEMENTS","JSONB_AGG",
  ];
  return sql
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(new RegExp(`\\b(${keywords.join("|")})\\b`, "g"), '<span class="sql-kw">$1</span>');
}

function genSessionKey(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function AnalystPage() {
  const [q, setQ] = useState("");
  const [phase, setPhase] = useState<"idle" | "thinking" | "done">("idle");
  const [result, setResult] = useState<AnalystResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [maxRows, setMaxRows] = useState(500);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [csvUpload, setCsvUpload] = useState<CsvUpload | null>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [sessionKey] = useState(genSessionKey);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function ask(text?: string) {
    const question = text ?? q;
    if (!question.trim() || phase === "thinking") return;
    if (text) setQ(text);
    setPhase("thinking");
    setError(null);
    setResult(null);
    setShowSql(false);

    try {
      const res = await fetch(`${RUNTIME}/api/analyst/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await runtimeAuthHeader()) },
        body: JSON.stringify({
          question: question.trim(),
          maxRows,
          sessionKey: csvUpload ? sessionKey : undefined,
        }),
      });
      const data = await res.json() as AnalystResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setResult(data);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPhase("idle");
    }
  }

  const handleCsvFile = useCallback(async (file: File) => {
    setCsvError(null);
    setCsvLoading(true);
    try {
      const text = await file.text();
      const res = await fetch(`${RUNTIME}/api/analyst/upload-csv`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await runtimeAuthHeader()) },
        body: JSON.stringify({
          sessionKey,
          sourceName: file.name,
          csvContent: text,
        }),
      });
      const data = await res.json() as CsvUpload & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setCsvUpload(data);
    } catch (err) {
      setCsvError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setCsvLoading(false);
    }
  }, [sessionKey]);

  function reset() {
    setPhase("idle");
    setResult(null);
    setError(null);
    setQ("");
    setShowSql(false);
    taRef.current?.focus();
  }

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Data Analyst</h1>
          <div className="sub">
            SQL over live Postgres tables — opportunities, contracts, candidates, runs & more. Read-only.
          </div>
        </div>
        {phase !== "idle" && (
          <button className="btn sm" onClick={reset}>New question</button>
        )}
      </div>

      <div className="analyst-shell">
        {/* ── CSV context badge ── */}
        {csvUpload && (
          <div className="csv-badge">
            <Table style={{ width: 12, height: 12 }} />
            <span><strong>{csvUpload.sourceName}</strong> · {csvUpload.rowCount.toLocaleString()} rows · {csvUpload.colNames.length} cols</span>
            <button
              className="csv-badge-rm"
              onClick={() => { setCsvUpload(null); if (fileRef.current) fileRef.current.value = ""; }}
              title="Remove upload"
            >
              <X style={{ width: 11, height: 11 }} />
            </button>
          </div>
        )}

        {/* ── Input ── */}
        <div className="analyst-input">
          <textarea
            ref={taRef}
            placeholder={csvUpload
              ? `Ask about "${csvUpload.sourceName}" or any other table…`
              : "Ask anything — e.g. which opportunities scored pursue this quarter?"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); }
            }}
            disabled={phase === "thinking"}
          />
          <div className="ask-foot">
            <div className="row gap-sm" style={{ alignItems: "center" }}>
              {/* CSV upload button */}
              <label className="btn sm" style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }} title="Upload CSV for analysis">
                {csvLoading
                  ? <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} />
                  : <Upload style={{ width: 12, height: 12 }} />}
                CSV
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv"
                  style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCsvFile(f); }}
                />
              </label>

              {/* Advanced toggle */}
              <button
                className="btn sm"
                onClick={() => setShowAdvanced((v) => !v)}
                style={{ display: "flex", alignItems: "center", gap: 4 }}
              >
                {showAdvanced ? <ChevronUp style={{ width: 11, height: 11 }} /> : <ChevronDown style={{ width: 11, height: 11 }} />}
                Advanced
              </button>
            </div>

            <div className="row gap-sm" style={{ alignItems: "center" }}>
              <span className="muted mono" style={{ fontSize: 11.5 }}>
                {phase === "thinking"
                  ? "Analyzing…"
                  : phase === "done" && result
                  ? `${(result.inputTokens + result.outputTokens).toLocaleString()} tokens`
                  : "⌘ + ↵ to ask"}
              </span>
              <button
                className="btn accent"
                onClick={() => ask()}
                disabled={!q.trim() || phase === "thinking"}
              >
                {phase === "thinking"
                  ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Working</>
                  : <><Send style={{ width: 13, height: 13 }} /> Ask</>}
              </button>
            </div>
          </div>

          {/* Advanced panel */}
          {showAdvanced && (
            <div className="advanced-panel">
              <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 10, color: "var(--ink-2)" }}>
                <span style={{ minWidth: 80 }}>Max rows</span>
                <input
                  type="range"
                  min={100}
                  max={5000}
                  step={100}
                  value={maxRows}
                  onChange={(e) => setMaxRows(Number(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span className="mono" style={{ minWidth: 42, textAlign: "right", color: "var(--ink)" }}>
                  {maxRows.toLocaleString()}
                </span>
              </label>
              <p className="hint" style={{ margin: "6px 0 0" }}>
                Aggregation queries (COUNT, SUM, GROUP BY) are unlimited — this cap only applies to raw row returns.
              </p>
            </div>
          )}
        </div>

        {csvError && (
          <div className="err-banner">{csvError}</div>
        )}

        {/* ── Example chips ── */}
        {phase === "idle" && !csvUpload && (
          <div className="ex-chips">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="ex-chip" onClick={() => ask(ex)}>{ex}</button>
            ))}
          </div>
        )}

        {phase === "idle" && csvUpload && (
          <div className="ex-chips">
            <button className="ex-chip" onClick={() => ask(`Summarize the data in ${csvUpload.sourceName}`)}>
              Summarize this dataset
            </button>
            <button className="ex-chip" onClick={() => ask(`Show the distribution of values in ${csvUpload.sourceName}`)}>
              Show value distribution
            </button>
            <button className="ex-chip" onClick={() => ask(`Find any anomalies or outliers in ${csvUpload.sourceName}`)}>
              Find anomalies
            </button>
          </div>
        )}

        {error && (
          <div className="err-banner">{error}</div>
        )}

        {phase !== "idle" && (
          <div className="answer-card">
            <div className="ah">
              <div className="ttl">Answer</div>
              {result && (
                <div className="row gap-sm">
                  {result.uploadedTables && result.uploadedTables.length > 0 && (
                    <span className="chip" style={{ fontSize: 11 }}>
                      <Table style={{ width: 10, height: 10 }} />
                      {result.uploadedTables.join(", ")}
                    </span>
                  )}
                  {result.rowCount != null && (
                    <span className="chip muted mono">{result.rowCount.toLocaleString()} rows</span>
                  )}
                  {result.sql && (
                    <button className="btn sm" onClick={() => setShowSql((v) => !v)}>
                      {showSql ? "Hide" : "Show"} SQL
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="body">
              {phase === "thinking" ? (
                <div className="row gap-sm muted">
                  <Loader2 style={{ width: 14, height: 14, animation: "spin 1s linear infinite" }} />
                  Inspecting schema and planning a query…
                </div>
              ) : (
                <div style={{ whiteSpace: "pre-wrap" }}>{result?.answer}</div>
              )}
            </div>
            {showSql && result?.sql && (
              <pre
                className="sql-block"
                dangerouslySetInnerHTML={{ __html: highlightSql(result.sql) }}
              />
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .csv-badge {
          display: flex; align-items: center; gap: 7px;
          padding: 7px 12px;
          background: oklch(97% 0.01 240);
          border: 1px solid oklch(88% 0.03 240);
          border-radius: 8px;
          font-size: 12.5px;
          color: var(--ink-2);
          margin-bottom: 10px;
        }
        [data-theme="dark"] .csv-badge {
          background: oklch(22% 0.02 240);
          border-color: oklch(32% 0.03 240);
        }
        .csv-badge strong { color: var(--ink); }
        .csv-badge-rm {
          margin-left: auto; background: none; border: none; cursor: pointer;
          color: var(--ink-3); display: flex; align-items: center; padding: 2px;
          border-radius: 3px;
        }
        .csv-badge-rm:hover { color: var(--err); background: var(--err-soft); }
        .advanced-panel {
          padding: 12px 14px;
          background: var(--bg-2);
          border-top: 1px solid var(--line);
          border-radius: 0 0 8px 8px;
        }
        .err-banner {
          margin-top: 12px;
          padding: 10px 14px;
          border: 1px solid var(--err-line);
          border-radius: 8px;
          background: var(--err-soft);
          color: var(--err);
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}
