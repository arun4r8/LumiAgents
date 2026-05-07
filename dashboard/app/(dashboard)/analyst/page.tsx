"use client";

import { useState, useRef } from "react";
import { Send, Loader2 } from "lucide-react";

const EXAMPLES = [
  "How many runs failed in the last 7 days, by orchestration?",
  "What's our average approval response time this month?",
  "Which orchestrations ran the most in the last 30 days?",
  "Top 5 most expensive orchestrations by token spend last week",
  "Show me approvals that are still pending",
];

interface AnalystResult {
  answer: string;
  sql?: string;
  rowCount?: number;
  inputTokens: number;
  outputTokens: number;
}

function highlightSql(sql: string): string {
  const keywords = [
    "SELECT","FROM","WHERE","GROUP BY","ORDER BY","HAVING","LIMIT","OFFSET",
    "JOIN","LEFT","RIGHT","INNER","OUTER","ON","AS","AND","OR","NOT","IN",
    "COUNT","SUM","AVG","MAX","MIN","ROUND","DISTINCT","CASE","WHEN","THEN",
    "ELSE","END","NULL","IS","INTERVAL","NOW","DATE_TRUNC","FILTER","WITH",
  ];
  return sql
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(
      new RegExp(`\\b(${keywords.join("|")})\\b`, "g"),
      '<span class="sql-kw">$1</span>'
    );
}

export default function AnalystPage() {
  const [q, setQ] = useState("");
  const [phase, setPhase] = useState<"idle" | "thinking" | "done">("idle");
  const [result, setResult] = useState<AnalystResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  async function ask(text?: string) {
    const question = text ?? q;
    if (!question.trim() || phase === "thinking") return;
    if (text) setQ(text);
    setPhase("thinking");
    setError(null);
    setResult(null);
    setShowSql(false);

    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_RUNTIME_URL}/api/analyst/query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: question.trim() }),
        },
      );
      const data = await res.json() as AnalystResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setResult(data);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPhase("idle");
    }
  }

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
          <div className="sub">Ask questions about runs, approvals, and orchestration metrics. Read-only.</div>
        </div>
        {phase !== "idle" && (
          <button className="btn sm" onClick={reset}>New question</button>
        )}
      </div>

      <div className="analyst-shell">
        <div className="analyst-input">
          <textarea
            ref={taRef}
            placeholder="Ask anything — e.g. how many runs failed in the last 7 days?"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                ask();
              }
            }}
            disabled={phase === "thinking"}
          />
          <div className="ask-foot">
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

        {phase === "idle" && (
          <div className="ex-chips">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="ex-chip" onClick={() => ask(ex)}>{ex}</button>
            ))}
          </div>
        )}

        {error && (
          <div style={{
            marginTop: 16,
            padding: "12px 16px",
            border: "1px solid var(--err-line)",
            borderRadius: 8,
            background: "var(--err-soft)",
            color: "var(--err)",
            fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {phase !== "idle" && (
          <div className="answer-card">
            <div className="ah">
              <div className="ttl">Answer</div>
              {result && (
                <div className="row gap-sm">
                  {result.rowCount != null && (
                    <span className="chip muted mono">{result.rowCount} rows</span>
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

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
