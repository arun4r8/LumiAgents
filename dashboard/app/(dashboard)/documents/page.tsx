"use client";
import { useState } from "react";

interface IngestResult { documentId: string; chunkCount: number; charCount: number }
interface QueryResult { answer: string; sources: Array<{ sourceName: string; chunkIndex: number; similarity: number }>; inputTokens: number; outputTokens: number }

export default function DocumentsPage() {
  const [tab, setTab] = useState<"query" | "ingest">("query");
  const [question, setQuestion] = useState("");
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);

  const [ingestName, setIngestName] = useState("");
  const [ingestContent, setIngestContent] = useState("");
  const [ingestKind, setIngestKind] = useState<"pdf" | "text" | "csv">("text");
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);
  const [ingestLoading, setIngestLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL;

  async function handleQuery(e: React.FormEvent) {
    e.preventDefault();
    setQueryLoading(true); setError(null); setQueryResult(null);
    try {
      const res = await fetch(`${RUNTIME}/api/documents/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json() as QueryResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setQueryResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally { setQueryLoading(false); }
  }

  async function handleIngest(e: React.FormEvent) {
    e.preventDefault();
    setIngestLoading(true); setError(null); setIngestResult(null);
    try {
      const res = await fetch(`${RUNTIME}/api/documents/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceName: ingestName, sourceKind: ingestKind, content: ingestContent }),
      });
      const data = await res.json() as IngestResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setIngestResult(data);
      setIngestName(""); setIngestContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally { setIngestLoading(false); }
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Documents</h1>
        <p className="text-sm text-gray-500 mt-1">Query company documents or ingest new ones</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-lg w-fit">
        {(["query", "ingest"] as const).map((t) => (
          <button key={t} onClick={() => { setTab(t); setError(null); }}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors capitalize ${tab === t ? "bg-white shadow-sm text-gray-900" : "text-gray-500 hover:text-gray-700"}`}>
            {t}
          </button>
        ))}
      </div>

      {error && <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700 mb-4">{error}</div>}

      {tab === "query" && (
        <div className="space-y-4">
          <form onSubmit={handleQuery} className="flex gap-2">
            <input value={question} onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a question about your company documents…"
              className="flex-1 px-4 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white" />
            <button type="submit" disabled={queryLoading || !question.trim()}
              className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {queryLoading ? "Searching…" : "Ask"}
            </button>
          </form>

          {queryResult && (
            <div className="space-y-3">
              <div className="bg-white rounded-xl border p-5">
                <p className="text-sm font-medium text-gray-500 mb-2">Answer</p>
                <div className="text-sm text-gray-800 whitespace-pre-wrap">{queryResult.answer}</div>
                <p className="text-xs text-gray-400 mt-3">{queryResult.inputTokens + queryResult.outputTokens} tokens</p>
              </div>
              {queryResult.sources.length > 0 && (
                <div className="bg-white rounded-xl border p-5">
                  <p className="text-sm font-medium text-gray-500 mb-3">Sources</p>
                  <div className="space-y-2">
                    {queryResult.sources.map((s, i) => (
                      <div key={i} className="flex items-center gap-3 text-xs text-gray-600">
                        <span className="font-medium">{s.sourceName}</span>
                        <span className="text-gray-400">§{s.chunkIndex + 1}</span>
                        <span className="ml-auto bg-green-50 text-green-700 px-2 py-0.5 rounded">{(s.similarity * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "ingest" && (
        <form onSubmit={handleIngest} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium block mb-1">Document name</label>
              <input value={ingestName} onChange={(e) => setIngestName(e.target.value)}
                placeholder="e.g. Capability Statement 2026"
                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Type</label>
              <select value={ingestKind} onChange={(e) => setIngestKind(e.target.value as "pdf" | "text" | "csv")}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="text">Text</option>
                <option value="pdf">PDF (paste extracted text)</option>
                <option value="csv">CSV</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Content</label>
            <textarea value={ingestContent} onChange={(e) => setIngestContent(e.target.value)}
              rows={12} placeholder="Paste document text here…"
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y" required />
          </div>
          <button type="submit" disabled={ingestLoading}
            className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {ingestLoading ? "Ingesting…" : "Ingest document"}
          </button>
          {ingestResult && (
            <div className="rounded-xl bg-green-50 border border-green-200 p-4 text-sm text-green-800">
              ✓ Ingested <strong>{ingestResult.chunkCount} chunks</strong> from {(ingestResult.charCount / 1000).toFixed(1)}k characters.
              Document ID: <code className="font-mono text-xs">{ingestResult.documentId}</code>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
