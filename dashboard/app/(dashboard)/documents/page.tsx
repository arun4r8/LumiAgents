"use client";

import { useState } from "react";
import { Search, Sparkles, Check, Loader2 } from "lucide-react";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

interface QueryResult {
  answer: string;
  sources: Array<{ sourceName: string; chunkIndex: number; similarity: number }>;
  inputTokens: number;
  outputTokens: number;
}
interface IngestResult { documentId: string; chunkCount: number; charCount: number }

const EXAMPLES = [
  "Section M evaluation factors for FedRAMP-High",
  "Lumiture past performance on AWS GovCloud",
  "NIST 800-53 account management controls",
];

export default function DocumentsPage() {
  const [tab, setTab] = useState<"query" | "ingest">("query");

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Documents</h1>
          <div className="sub">RAG corpus · query company documents or ingest new ones</div>
        </div>
      </div>

      <div className="tabs">
        <button className={tab === "query" ? "active" : ""} onClick={() => setTab("query")}>Query</button>
        <button className={tab === "ingest" ? "active" : ""} onClick={() => setTab("ingest")}>Ingest</button>
      </div>

      {tab === "query" ? <DocsQuery /> : <DocsIngest />}
    </div>
  );
}

function DocsQuery() {
  const [q, setQ] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "done">("idle");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q.trim() || phase === "loading") return;
    setPhase("loading");
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${RUNTIME}/api/documents/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json() as QueryResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setResult(data);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
      setPhase("idle");
    }
  }

  return (
    <div>
      <form onSubmit={submit} className="row gap-sm" style={{ marginBottom: 14 }}>
        <div className="search" style={{ flex: 1 }}>
          <Search />
          <input
            placeholder="Ask a question against the document corpus…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ height: 38 }}
          />
        </div>
        <button
          type="submit"
          className="btn accent"
          disabled={!q.trim() || phase === "loading"}
          style={{ height: 38, padding: "0 16px" }}
        >
          {phase === "loading"
            ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Searching</>
            : <><Search style={{ width: 13, height: 13 }} /> Search</>}
        </button>
      </form>

      {phase === "idle" && (
        <div className="ex-chips" style={{ marginTop: 0, marginBottom: 22 }}>
          {EXAMPLES.map((ex) => (
            <button key={ex} className="ex-chip" onClick={() => { setQ(ex); setTimeout(submit, 30); }}>
              {ex}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div style={{ padding: "12px 16px", border: "1px solid var(--err-line)", borderRadius: 8, background: "var(--err-soft)", color: "var(--err)", fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {phase === "loading" && (
        <div className="empty">
          <Loader2 style={{ width: 22, height: 22, color: "var(--accent)", animation: "spin 1s linear infinite" }} />
        </div>
      )}

      {phase === "done" && result && (
        <>
          <div className="section-h">
            <h3>Answer</h3>
            <div className="meta mono">{(result.inputTokens + result.outputTokens).toLocaleString()} tokens</div>
          </div>
          <div className="card" style={{ padding: "14px 16px", marginBottom: 16, fontSize: 14, lineHeight: 1.6, color: "var(--ink-1)" }}>
            {result.answer}
          </div>

          {result.sources.length > 0 && (
            <>
              <div className="section-h">
                <h3>Sources ({result.sources.length})</h3>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {result.sources.map((s, i) => (
                  <div key={i} className="chunk">
                    <div className="ch">
                      <div className="src">{s.sourceName}</div>
                      <div className="score">{(s.similarity * 100).toFixed(0)}%</div>
                    </div>
                    <div className="bar"><div className="fill" style={{ width: `${s.similarity * 100}%` }} /></div>
                    <div className="body" style={{ color: "var(--ink-2)", fontSize: 12 }}>Chunk §{s.chunkIndex + 1}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function DocsIngest() {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"text" | "pdf" | "csv">("text");
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "done">("idle");
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const useFile = kind === "csv" || kind === "pdf";

  function handleKindChange(next: "text" | "pdf" | "csv") {
    setKind(next);
    setContent("");
    setFileName(null);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ""));
    const reader = new FileReader();
    reader.onload = (ev) => setContent(ev.target?.result as string ?? "");
    reader.readAsText(file);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;
    setPhase("loading"); setError(null); setResult(null);
    try {
      const res = await fetch(`${RUNTIME}/api/documents/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceName: name, sourceKind: kind, content }),
      });
      const data = await res.json() as IngestResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setResult(data);
      setName(""); setContent(""); setFileName(null);
      setPhase("done");
      setTimeout(() => setPhase("idle"), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
      setPhase("idle");
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 22 }}>
      <form onSubmit={submit} className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="field">
          <label>Source name</label>
          <input className="input" placeholder="e.g. NIST SP 800-53 Rev 5" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label>Source kind</label>
          <select className="sel" value={kind} onChange={(e) => handleKindChange(e.target.value as "text" | "pdf" | "csv")}>
            <option value="text">text</option>
            <option value="pdf">pdf</option>
            <option value="csv">csv</option>
          </select>
        </div>
        <div className="field">
          <label>Content</label>
          {useFile ? (
            <div>
              <label
                htmlFor="file-upload"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 14px",
                  border: "1px dashed var(--line)",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: 13.5,
                  color: fileName ? "var(--ink)" : "var(--ink-3)",
                  background: "var(--bg-2)",
                  transition: "border-color 120ms",
                }}
              >
                <Sparkles style={{ width: 14, height: 14, flexShrink: 0, color: "var(--accent)" }} />
                {fileName ?? `Choose a .${kind} file to upload`}
              </label>
              <input
                id="file-upload"
                type="file"
                accept={kind === "csv" ? ".csv,text/csv" : ".pdf,.txt,text/plain"}
                onChange={handleFileChange}
                style={{ display: "none" }}
              />
              {kind === "pdf" && (
                <span className="hint">Upload a text-based PDF or a .txt export of one.</span>
              )}
              {kind === "csv" && (
                <span className="hint">CSV will be chunked row-by-row for retrieval.</span>
              )}
            </div>
          ) : (
            <>
              <textarea
                className="ta mono"
                placeholder="Paste content here…"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                style={{ minHeight: 180 }}
                required
              />
              <span className="hint">Will be chunked at ~480 chars with 60-char overlap.</span>
            </>
          )}
        </div>
        {error && (
          <div style={{ fontSize: 12.5, color: "var(--err)" }}>{error}</div>
        )}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          {phase === "done" && result && (
            <span className="chip ok">
              <Check style={{ width: 10, height: 10 }} />
              {result.chunkCount} chunks ingested
            </span>
          )}
          <button type="submit" className="btn accent" disabled={!name.trim() || !content.trim() || phase === "loading"}>
            {phase === "loading"
              ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Embedding</>
              : <><Sparkles style={{ width: 13, height: 13 }} /> Ingest</>}
          </button>
        </div>
      </form>

      <div>
        <div className="section-h" style={{ marginTop: 0 }}>
          <h3>Recent ingestions</h3>
        </div>
        <div className="muted" style={{ fontSize: 12.5, padding: "16px 0" }}>
          Ingestion history not yet available.
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
