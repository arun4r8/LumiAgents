"use client";

import { useState, useTransition, useRef } from "react";
import { Search, Sparkles, Check, Loader2, Trash2, FileText, FileSpreadsheet, File, Upload, ScanText } from "lucide-react";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

interface OrcDocument {
  id: string;
  source_name: string;
  source_kind: string;
  char_count: number | null;
  created_at: string;
}

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

export function DocumentsClient({
  documents,
  deleteDocument,
}: {
  documents: OrcDocument[];
  deleteDocument: (id: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<"query" | "ingest">("query");

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Documents</h1>
          <div className="sub">RAG corpus · {documents.length} document{documents.length !== 1 ? "s" : ""} ingested</div>
        </div>
      </div>

      <div className="tabs">
        <button className={tab === "query" ? "active" : ""} onClick={() => setTab("query")}>Query</button>
        <button className={tab === "ingest" ? "active" : ""} onClick={() => setTab("ingest")}>Ingest</button>
        <button className={tab === "corpus" as typeof tab ? "active" : ""} onClick={() => setTab("corpus" as typeof tab)}>
          Corpus
          <span className="count" style={{ marginLeft: 6 }}>{documents.length}</span>
        </button>
      </div>

      {tab === "query" && <DocsQuery />}
      {tab === "ingest" && <DocsIngest />}
      {tab === ("corpus" as string) && <DocCorpus documents={documents} deleteDocument={deleteDocument} />}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Query tab ────────────────────────────────────────────────────────────────

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
    </div>
  );
}

// ─── Ingest tab ───────────────────────────────────────────────────────────────

function DocsIngest() {
  const [mode, setMode] = useState<"file" | "text">("file");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {(["file", "text"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`btn${mode === m ? " accent" : " ghost"} sm`}
          >
            {m === "file"
              ? <><ScanText style={{ width: 12, height: 12 }} /> File upload (OCR)</>
              : <><FileText style={{ width: 12, height: 12 }} /> Paste text / CSV</>}
          </button>
        ))}
      </div>

      {mode === "file" ? <FileIngest /> : <TextIngest />}
    </div>
  );
}

function FileIngest() {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<"idle" | "ocr" | "embedding" | "done">("idle");
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loading = phase === "ocr" || phase === "embedding";

  function pickFile(f: File) {
    setFile(f);
    setError(null);
    if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, ""));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !name.trim() || loading) return;
    setError(null); setResult(null);
    setPhase("ocr");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("sourceName", name);
      // Switch label after a moment so user knows OCR finished and embedding is running
      const ocrTimer = setTimeout(() => setPhase("embedding"), 8000);
      const res = await fetch(`${RUNTIME}/api/documents/ingest-file`, { method: "POST", body: fd });
      clearTimeout(ocrTimer);
      const data = await res.json() as IngestResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setResult(data);
      setFile(null); setName("");
      if (inputRef.current) inputRef.current.value = "";
      setPhase("done");
      setTimeout(() => setPhase("idle"), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
      setPhase("idle");
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 22 }}>
      <form onSubmit={submit} className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) pickFile(f);
          }}
          onClick={() => inputRef.current?.click()}
          style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", gap: 8, padding: "28px 20px",
            border: `2px dashed ${dragging ? "var(--accent)" : file ? "oklch(58% 0.17 145)" : "var(--line)"}`,
            borderRadius: 10, cursor: "pointer", textAlign: "center",
            background: dragging ? "var(--accent-soft)" : file ? "oklch(97% 0.02 145)" : "var(--bg-2)",
            transition: "all 120ms",
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); }}
          />
          {file ? (
            <>
              <ScanText style={{ width: 22, height: 22, color: "oklch(58% 0.17 145)" }} />
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{file.name}</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                {file.type || "unknown type"} · {(file.size / 1024).toFixed(0)} KB
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Click to change</div>
            </>
          ) : (
            <>
              <Upload style={{ width: 22, height: 22, color: "var(--ink-4)" }} />
              <div style={{ fontSize: 13.5, color: "var(--ink-2)", fontWeight: 500 }}>
                Drop a file here or click to browse
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-4)" }}>PDF · PNG · JPG · WEBP</div>
            </>
          )}
        </div>

        <div className="field">
          <label>Source name</label>
          <input
            className="input"
            placeholder="e.g. NIST SP 800-53 Rev 5"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        {error && <div style={{ fontSize: 12.5, color: "var(--err)" }}>{error}</div>}

        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          {phase === "done" && result && (
            <span className="chip ok">
              <Check style={{ width: 10, height: 10 }} />
              {result.chunkCount} chunks embedded
            </span>
          )}
          <button
            type="submit"
            className="btn accent"
            disabled={!file || !name.trim() || loading}
          >
            {phase === "ocr"
              ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Extracting text…</>
              : phase === "embedding"
                ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Embedding…</>
                : <><ScanText style={{ width: 13, height: 13 }} /> OCR + Ingest</>}
          </button>
        </div>
      </form>

      <div className="card" style={{ padding: 18 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>How it works</div>
        <ol style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.8, paddingLeft: 18, margin: 0 }}>
          <li>File is sent to Claude for text extraction (OCR).</li>
          <li>Extracted text is chunked at ~1,200 chars with 200-char overlap.</li>
          <li>Each chunk is embedded via Cloudflare Workers AI.</li>
          <li>Chunks are stored in Supabase with pgvector for semantic search.</li>
        </ol>
        <div style={{ marginTop: 14, fontSize: 12, color: "var(--ink-3)", lineHeight: 1.6 }}>
          Supported: scanned PDFs, native PDFs, PNG/JPG screenshots, WEBP. Use <strong>Paste text</strong> for plain text or CSV files.
        </div>
      </div>
    </div>
  );
}

function TextIngest() {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"text" | "csv">("text");
  const [content, setContent] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "done">("idle");
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, ""));
    const reader = new FileReader();
    reader.onload = (ev) => setContent(ev.target?.result as string ?? "");
    reader.readAsText(f);
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
      setName(""); setContent("");
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
          <label>Kind</label>
          <select className="sel" value={kind} onChange={(e) => setKind(e.target.value as "text" | "csv")}>
            <option value="text">text</option>
            <option value="csv">csv</option>
          </select>
        </div>
        <div className="field">
          <label>Content</label>
          {kind === "csv" ? (
            <div>
              <label htmlFor="csv-upload" style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", border: "1px dashed var(--line)", borderRadius: 8,
                cursor: "pointer", fontSize: 13.5, color: content ? "var(--ink)" : "var(--ink-3)",
                background: "var(--bg-2)",
              }}>
                <FileSpreadsheet style={{ width: 14, height: 14, flexShrink: 0, color: "var(--accent)" }} />
                {content ? "CSV loaded — paste or re-upload to replace" : "Choose a .csv file or paste below"}
              </label>
              <input id="csv-upload" type="file" accept=".csv,text/csv" onChange={handleFileChange} style={{ display: "none" }} />
              <textarea className="ta mono" placeholder="Or paste CSV content here…"
                value={content} onChange={(e) => setContent(e.target.value)}
                style={{ minHeight: 120, marginTop: 8 }} />
              <span className="hint">Chunked row-by-row, one chunk per row.</span>
            </div>
          ) : (
            <>
              <textarea className="ta mono" placeholder="Paste content here…"
                value={content} onChange={(e) => setContent(e.target.value)}
                style={{ minHeight: 200 }} required />
              <span className="hint">Chunked at ~1,200 chars with 200-char overlap.</span>
            </>
          )}
        </div>
        {error && <div style={{ fontSize: 12.5, color: "var(--err)" }}>{error}</div>}
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

      <div className="card" style={{ padding: 18 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Tips</div>
        <ul style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.7, paddingLeft: 16, margin: 0 }}>
          <li>Use clear, descriptive source names — they appear in query citations.</li>
          <li>CSVs are chunked row-by-row, one chunk per row.</li>
          <li>For PDFs or images, use <strong>File upload (OCR)</strong> above.</li>
          <li>After ingesting, use <strong>Query</strong> to verify the content is retrievable.</li>
          <li>Manage the corpus in the <strong>Corpus</strong> tab.</li>
        </ul>
      </div>
    </div>
  );
}

// ─── Corpus tab ───────────────────────────────────────────────────────────────

function kindIcon(kind: string) {
  if (kind === "csv") return <FileSpreadsheet style={{ width: 14, height: 14, color: "var(--ink-3)" }} />;
  if (kind === "pdf") return <File style={{ width: 14, height: 14, color: "var(--err)" }} />;
  return <FileText style={{ width: 14, height: 14, color: "var(--accent)" }} />;
}

function DocCorpus({
  documents,
  deleteDocument,
}: {
  documents: OrcDocument[];
  deleteDocument: (id: string) => Promise<void>;
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleDelete(id: string) {
    setDeletingId(id);
    startTransition(async () => {
      await deleteDocument(id);
      setDeletingId(null);
    });
  }

  if (documents.length === 0) {
    return (
      <div className="empty" style={{ paddingTop: 48 }}>
        <FileText style={{ width: 28, height: 28, color: "var(--ink-4)" }} />
        <h4>No documents ingested yet</h4>
        <p>Use the Ingest tab to add documents to the RAG corpus.</p>
      </div>
    );
  }

  const totalChars = documents.reduce((s, d) => s + (d.char_count ?? 0), 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
        <div className="card" style={{ padding: "12px 18px", flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{documents.length}</div>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>documents</div>
        </div>
        <div className="card" style={{ padding: "12px 18px", flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{(totalChars / 1000).toFixed(0)}k</div>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>characters</div>
        </div>
        <div className="card" style={{ padding: "12px 18px", flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {[...new Set(documents.map((d) => d.source_kind))].join(" · ") || "—"}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>source kinds</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {documents.map((doc) => (
          <div key={doc.id} className="card" style={{
            padding: "10px 14px", display: "flex", alignItems: "center", gap: 12,
          }}>
            {kindIcon(doc.source_kind)}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {doc.source_name}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>
                {doc.source_kind} · {doc.char_count ? `${(doc.char_count / 1000).toFixed(1)}k chars` : "unknown size"} ·{" "}
                {new Date(doc.created_at).toLocaleDateString()}
              </div>
            </div>
            <span className="chip muted" style={{ fontSize: 10.5 }}>{doc.source_kind}</span>
            <button
              className="btn ghost sm"
              style={{ color: "var(--err)", padding: "4px 8px" }}
              onClick={() => handleDelete(doc.id)}
              disabled={deletingId === doc.id}
              title="Delete document and all its chunks"
            >
              {deletingId === doc.id
                ? <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} />
                : <Trash2 style={{ width: 12, height: 12 }} />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
