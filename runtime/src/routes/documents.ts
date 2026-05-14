import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../types";
import { ingestDocument, queryDocuments } from "../agents/document-rag";
import { runDataAnalyst, storeCsvUpload } from "../agents/data-analyst";
import { SupabaseClient } from "../db/client";
import { json, parseCsvLine } from "./helpers";

// ─── OCR helpers ──────────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode(...Array.from(bytes.slice(i, i + CHUNK))));
  }
  return btoa(chunks.join(""));
}

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
  };
  return map[ext] ?? "application/octet-stream";
}

async function ocrWithClaude(env: Env, base64: string, mimeType: string): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

  const contentBlock: Anthropic.Messages.ContentBlockParam = mimeType === "application/pdf"
    ? {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 },
      }
    : {
        type: "image",
        source: { type: "base64", media_type: mimeType as ImageMediaType, data: base64 },
      };

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8192,
    messages: [{
      role: "user",
      content: [
        contentBlock,
        {
          type: "text",
          text: "Extract all text from this document. Preserve structure — headings, bullet points, tables, numbered lists — as closely as possible. Return only the extracted text with no commentary.",
        },
      ],
    }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("OCR returned no text content");
  return textBlock.text;
}

export async function handleDocuments(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;

  // POST /api/documents/ingest-file  (multipart — OCR via Claude then embed)
  if (pathname === "/api/documents/ingest-file" && request.method === "POST") {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return json({ error: "Invalid multipart form data" }, 400);
    }

    const fileEntry = formData.get("file");
    // File is a Fetch API type — check for arrayBuffer presence rather than instanceof
    if (fileEntry === null || typeof fileEntry === "string" || !("arrayBuffer" in fileEntry)) {
      return json({ error: "file field is required" }, 400);
    }
    const file = fileEntry as File;

    const sourceName = ((formData.get("sourceName") as string | null) ?? "").trim()
      || file.name.replace(/\.[^.]+$/, "");

    const mimeType = file.type || guessMime(file.name);
    const isPdf = mimeType === "application/pdf";
    const isImage = mimeType.startsWith("image/");

    if (!isPdf && !isImage) {
      return json({ error: "Unsupported file type. Upload a PDF or image (PNG, JPG, WEBP)." }, 400);
    }

    const bytes = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(bytes);

    let extractedText: string;
    try {
      extractedText = await ocrWithClaude(env, base64, mimeType);
    } catch (err) {
      return json({ error: `OCR failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }

    const db = new SupabaseClient(env);
    const orchRecord = await db.getOrchestrationByName("patch/document-ingest").catch(() => null);

    const run = orchRecord
      ? await db.createRun({
          orchestration_id: orchRecord.id,
          orchestration_version: 1,
          status: "running",
          input: { sourceName, sourceKind: isPdf ? "pdf" : "text", fileName: file.name },
          triggered_by: "webhook",
          started_at: new Date().toISOString(),
        }).catch(() => null)
      : null;

    const result = await ingestDocument(env, {
      sourceName,
      sourceKind: isPdf ? "pdf" : "text",
      content: extractedText,
    });

    if (run) {
      await db.updateRun(run.id, {
        status: "completed",
        output: result,
        ended_at: new Date().toISOString(),
      });
    }

    return json({ ...result, runId: run?.id });
  }

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
