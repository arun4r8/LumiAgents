import type { Env } from "./types";
import { ingestDocument, queryDocuments } from "./agents/document-rag";
import { runDataAnalyst } from "./agents/data-analyst";
import { SupabaseClient } from "./db/client";

// ─── Request helpers ──────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function parseBody(req: Request): Promise<unknown> {
  const ct = req.headers.get("Content-Type") ?? "";
  if (ct.includes("application/json")) return req.json();
  if (ct.includes("multipart/form-data")) return req.formData();
  return null;
}

// ─── Main Worker ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    try {
      // ── Document RAG: ingest ────────────────────────────────────────────────
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
        const orchRecord = await db.getOrchestrationByName("document-ingest").catch(() => null);

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

      // ── Document RAG: query ─────────────────────────────────────────────────
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

      // ── Data Analyst ────────────────────────────────────────────────────────
      if (pathname === "/api/analyst/query" && request.method === "POST") {
        const body = await request.json() as {
          question: string;
          tables?: string[];
          maxRows?: number;
        };

        if (!body.question) {
          return json({ error: "question is required" }, 400);
        }

        const result = await runDataAnalyst(env, body);
        return json(result);
      }

      // ── Health ──────────────────────────────────────────────────────────────
      if (pathname === "/health") {
        return json({ status: "ok", environment: env.ENVIRONMENT });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error("Worker error:", err);
      return json(
        { error: err instanceof Error ? err.message : "Internal server error" },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
