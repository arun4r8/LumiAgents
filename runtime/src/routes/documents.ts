import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../types";
import { ingestDocument, queryDocuments } from "../agents/document-rag";
import { OPS_SCOPE } from "../agents/knowledge-access";
import { runDataAnalyst, storeCsvUpload } from "../agents/data-analyst";
import { SupabaseClient } from "../db/client";
import { json, parseCsvLine, requireOpsToken, rateLimited } from "./helpers";

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
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const rl = await rateLimited(env, authResult.userId, "documents", 20);
    if (rl) return rl;

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
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const rl = await rateLimited(env, authResult.userId, "documents", 20);
    if (rl) return rl;

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
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const rl = await rateLimited(env, authResult.userId, "documents", 20);
    if (rl) return rl;

    const body = await request.json() as {
      question: string;
      minSimilarity?: number;
      maxChunks?: number;
    };

    if (!body.question) {
      return json({ error: "question is required" }, 400);
    }

    // Dashboard document search is an ops surface — full corpus access, incl. restricted.
    const result = await queryDocuments(env, { ...body, allowedCorpora: OPS_SCOPE.allowedCorpora, includeRestricted: OPS_SCOPE.includeRestricted });
    return json(result);
  }

  // POST /api/analyst/query
  if (pathname === "/api/analyst/query" && request.method === "POST") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const rl = await rateLimited(env, authResult.userId, "analyst", 20);
    if (rl) return rl;

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
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const rl = await rateLimited(env, authResult.userId, "analyst", 20);
    if (rl) return rl;

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

  // GET /api/documents — list all RAG corpus documents with chunk counts, ops-only
  if (pathname === "/api/documents" && request.method === "GET") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const base = `${env.SUPABASE_URL}/rest/v1`;
    const headers = {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Profile": "orchestration",
    };

    const docsRes = await fetch(
      `${base}/orch_documents?select=id,source_name,source_kind,source_uri,metadata,char_count,created_at&order=created_at.desc&limit=500`,
      { headers },
    );

    if (!docsRes.ok) {
      const errText = await docsRes.text();
      return json({ error: `Failed to fetch documents: ${errText}` }, 502);
    }

    interface RawDoc {
      id: string;
      source_name: string;
      source_kind: string;
      source_uri: string | null;
      metadata: Record<string, unknown>;
      char_count: number | null;
      created_at: string;
    }

    const docs = await docsRes.json() as RawDoc[];

    // Build chunk counts via a second query (skip if no documents)
    const chunkCountMap = new Map<string, number>();
    if (docs.length > 0) {
      const ids = docs.map((d) => d.id).join(",");
      const chunksRes = await fetch(
        `${base}/document_chunks?select=document_id,id&document_id=in.(${ids})`,
        { headers },
      );
      if (chunksRes.ok) {
        const chunks = await chunksRes.json() as Array<{ document_id: string; id: string }>;
        for (const c of chunks) {
          chunkCountMap.set(c.document_id, (chunkCountMap.get(c.document_id) ?? 0) + 1);
        }
      }
    }

    const result = docs.map((d) => ({
      id: d.id,
      source_name: d.source_name,
      source_kind: d.source_kind,
      source_uri: d.source_uri,
      metadata: d.metadata,
      char_count: d.char_count,
      created_at: d.created_at,
      chunk_count: chunkCountMap.get(d.id) ?? 0,
    }));

    return json(result);
  }

  // DELETE /api/documents/:id — delete a document (cascades to chunks via FK), ops-only
  const docMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (docMatch && request.method === "DELETE") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const id = docMatch[1]!;

    const base = `${env.SUPABASE_URL}/rest/v1`;
    const headers = {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Profile": "orchestration",
      Prefer: "return=minimal",
    };

    const delRes = await fetch(
      `${base}/orch_documents?id=eq.${encodeURIComponent(id)}`,
      { method: "DELETE", headers },
    );

    if (!delRes.ok) {
      const errText = await delRes.text();
      return json({ error: `Failed to delete document: ${errText}` }, 502);
    }

    return json({ deleted: true });
  }

  return null;
}
