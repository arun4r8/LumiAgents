import type { Env } from "../types";
import { chunkText } from "../utils/chunker";

const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sbHeaders(env: Env) {
  return {
    "Content-Type": "application/json",
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Prefer: "return=representation",
  };
}

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const ai = (env as unknown as {
    AI: { run: (model: string, input: { text: string[] }) => Promise<{ data: number[][] }> };
  }).AI;
  const result = await ai.run(EMBEDDING_MODEL, { text: texts });
  return result.data;
}

// ─── Upsert a vault file ──────────────────────────────────────────────────────
// source_uri format: 'github:{owner}/{repo}:{path}'
// If the file already exists with the same blobSha, skips re-embedding.
// Returns true if ingested, false if skipped (unchanged).

export async function upsertVaultDocument(
  env: Env,
  opts: {
    sourceUri:  string;
    sourceName: string;   // friendly display name (filename or title)
    content:    string;
    blobSha:    string;
    metadata:   Record<string, unknown>;
  },
): Promise<{ ingested: boolean; documentId: string }> {
  const base = `${env.SUPABASE_URL}/rest/v1`;

  // Check if a matching row already exists with the same blob SHA
  const existing = await fetch(
    `${base}/orch_documents?source_uri=eq.${encodeURIComponent(opts.sourceUri)}&select=id,metadata`,
    { headers: sbHeaders(env) },
  );
  if (!existing.ok) throw new Error(`Supabase lookup failed: ${existing.status}`);

  const rows = await existing.json() as Array<{ id: string; metadata: Record<string, unknown> }>;
  const existingRow = rows[0];

  if (existingRow && existingRow.metadata?.["github_blob_sha"] === opts.blobSha) {
    return { ingested: false, documentId: existingRow.id };
  }

  // Delete existing row if present (cascades to document_chunks via FK)
  if (existingRow) {
    const del = await fetch(
      `${base}/orch_documents?source_uri=eq.${encodeURIComponent(opts.sourceUri)}`,
      { method: "DELETE", headers: sbHeaders(env) },
    );
    if (!del.ok) throw new Error(`Supabase delete failed: ${del.status}`);
  }

  // Insert new document row
  const insertRes = await fetch(`${base}/orch_documents`, {
    method: "POST",
    headers: sbHeaders(env),
    body: JSON.stringify({
      source_name: opts.sourceName,
      source_kind: "vault",
      source_uri:  opts.sourceUri,
      content:     opts.content,
      metadata:    { ...opts.metadata, github_blob_sha: opts.blobSha },
    }),
  });
  if (!insertRes.ok) throw new Error(`Supabase insert failed: ${insertRes.status} ${await insertRes.text()}`);

  const [doc] = await insertRes.json() as Array<{ id: string }>;
  if (!doc) throw new Error("No document row returned from Supabase insert");

  // Chunk, embed, and store
  const chunks = chunkText(opts.content, 1200, 200);
  const BATCH = 50;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const embeddings = await embed(env, batch.map((c) => c.content));
    allEmbeddings.push(...embeddings);
  }

  const chunkRows = chunks.map((chunk, i) => ({
    document_id:  doc.id,
    chunk_index:  chunk.index,
    content:      chunk.content,
    embedding:    `[${(allEmbeddings[i] ?? []).join(",")}]`,
  }));

  for (let i = 0; i < chunkRows.length; i += 100) {
    const res = await fetch(`${base}/orchestration.document_chunks`, {
      method: "POST",
      headers: sbHeaders(env),
      body: JSON.stringify(chunkRows.slice(i, i + 100)),
    });
    if (!res.ok) throw new Error(`Supabase chunk insert failed: ${res.status}`);
  }

  return { ingested: true, documentId: doc.id };
}

// ─── Remove a vault file ──────────────────────────────────────────────────────

export async function removeVaultDocument(env: Env, sourceUri: string): Promise<boolean> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/orch_documents?source_uri=eq.${encodeURIComponent(sourceUri)}`,
    { method: "DELETE", headers: sbHeaders(env) },
  );
  if (!res.ok) throw new Error(`Supabase delete vault doc failed: ${res.status}`);
  return true;
}
