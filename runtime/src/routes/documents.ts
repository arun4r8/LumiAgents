import type { Env } from "../types";
import { ingestDocument, queryDocuments } from "../agents/document-rag";
import { runDataAnalyst, storeCsvUpload } from "../agents/data-analyst";
import { SupabaseClient } from "../db/client";
import { json, parseCsvLine } from "./helpers";

export async function handleDocuments(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;

  // POST /api/documents/ingest
  if (pathname === "/api/documents/ingest" && request.method === "POST") {
    const body = await request.json() as {
      sourceName: string;
      sourceKind: "pdf" | "text" | "csv" | "url";
      content: string;
      storagePath?: string;
      metadata?: Record<string, unknown>;
    };

    if (!body.sourceName || !body.sourceKind || !body.content) {
      return json({ error: "sourceName, sourceKind, and content are required" }, 400);
    }

    const db = new SupabaseClient(env);
    const orchRecord = await db.getOrchestrationByName("patch/document-ingest").catch(() => null);

    const run = orchRecord
      ? await db.createRun({
          orchestration_id: orchRecord.id,
          orchestration_version: 1,
          status: "running",
          input: body,
          triggered_by: "webhook",
          started_at: new Date().toISOString(),
        })
      : null;

    const result = await ingestDocument(env, body);

    if (run) {
      await db.updateRun(run.id, {
        status: "completed",
        output: result,
        ended_at: new Date().toISOString(),
      });
    }

    return json({ ...result, runId: run?.id });
  }

  // POST /api/documents/query
  if (pathname === "/api/documents/query" && request.method === "POST") {
    const body = await request.json() as {
      question: string;
      minSimilarity?: number;
      maxChunks?: number;
    };

    if (!body.question) {
      return json({ error: "question is required" }, 400);
    }

    const result = await queryDocuments(env, body);
    return json(result);
  }

  // POST /api/analyst/query
  if (pathname === "/api/analyst/query" && request.method === "POST") {
    const body = await request.json() as {
      question: string;
      tables?: string[];
      maxRows?: number;
      sessionKey?: string;
    };

    if (!body.question) {
      return json({ error: "question is required" }, 400);
    }

    const result = await runDataAnalyst(env, body);
    return json(result);
  }

  // POST /api/analyst/upload-csv
  if (pathname === "/api/analyst/upload-csv" && request.method === "POST") {
    const body = await request.json() as {
      sessionKey: string;
      sourceName: string;
      csvContent: string;
    };

    if (!body.sessionKey || !body.sourceName || !body.csvContent) {
      return json({ error: "sessionKey, sourceName, and csvContent are required" }, 400);
    }

    const lines = body.csvContent.trim().split(/\r?\n/);
    if (lines.length < 2) {
      return json({ error: "CSV must have at least a header row and one data row" }, 400);
    }

    const colNames = parseCsvLine(lines[0] ?? "");
    const rows = lines.slice(1, 5001).map((line) => {
      const vals = parseCsvLine(line);
      const row: Record<string, string> = {};
      colNames.forEach((col, i) => { row[col] = vals[i] ?? ""; });
      return row;
    });

    const result = await storeCsvUpload(env, {
      sessionKey: body.sessionKey,
      sourceName: body.sourceName,
      rows,
      colNames,
    });

    return json(result);
  }

  return null;
}
