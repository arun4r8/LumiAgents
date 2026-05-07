"use client";
import { useState } from "react";

interface AnalystResult {
  answer: string;
  sql?: string;
  rowCount?: number;
  inputTokens: number;
  outputTokens: number;
}

export default function AnalystPage() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AnalystResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  const EXAMPLES = [
    "How many opportunities do we have by agency?",
    "What's our total contract value by status?",
    "Show me the top 10 candidates by overall score for each job",
    "What's our labor spend by contract this fiscal year?",
    "Which opportunities are due in the next 30 days?",
  ];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setShowSql(false);

    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_RUNTIME_URL}/api/analyst/query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question }),
        },
      );
      const data = await res.json() as AnalystResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Data Analyst</h1>
        <p className="text-sm text-gray-500 mt-1">Ask questions about your data in plain English</p>
      </div>

      {/* Example questions */}
      <div className="flex flex-wrap gap-2 mb-4">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => setQuestion(ex)}
            className="text-xs px-3 py-1.5 bg-white border rounded-full text-gray-600 hover:bg-gray-50 hover:border-gray-400 transition-colors"
          >
            {ex}
          </button>
        ))}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex gap-2 mb-6">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question about your data…"
          className="flex-1 px-4 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        />
        <button
          type="submit"
          disabled={loading || !question.trim()}
          className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {loading ? "Analyzing…" : "Ask"}
        </button>
      </form>

      {/* Error */}
      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700 mb-4">
          {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="space-y-4">
          {/* Answer */}
          <div className="bg-white rounded-xl border p-5">
            <p className="text-sm text-gray-500 mb-2 font-medium">Answer</p>
            <div className="text-sm text-gray-800 whitespace-pre-wrap">{result.answer}</div>
            <div className="mt-3 flex items-center gap-3 text-xs text-gray-400">
              {result.rowCount !== undefined && <span>{result.rowCount} rows</span>}
              <span>{result.inputTokens + result.outputTokens} tokens</span>
              {result.sql && (
                <button
                  onClick={() => setShowSql((v) => !v)}
                  className="text-blue-500 hover:underline"
                >
                  {showSql ? "Hide SQL" : "Show SQL"}
                </button>
              )}
            </div>
          </div>

          {/* SQL */}
          {showSql && result.sql && (
            <div className="bg-gray-900 rounded-xl p-4">
              <p className="text-xs text-gray-400 mb-2 font-medium">Generated SQL</p>
              <pre className="text-xs text-green-300 font-mono whitespace-pre-wrap">{result.sql}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
