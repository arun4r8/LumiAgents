import type { Env } from "../types";
import { chunkText } from "../utils/chunker";
import { sbHeaders } from "../utils/supabase";

const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Both tables live in the `orchestration` schema, which PostgREST selects by HEADER.
// This file used its own headers with no profile and one dotted path
// (`/orchestration.document_chunks`), so the lookup queried `public.orch_documents`
// (which does not exist) and the chunk insert 404'd. It never showed, because
// nothing called it successfully: vault-sync was unregistered (#181) and
// past-performance-seed has never run.
const orch = (env: Env) => sbHeaders(env, { profile: "orchestration", extra: { Prefer: "return=representation" } });

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
    /**
     * The document's current index row, when the caller already loaded it. Pass
     * null for "known not indexed". Omit to look it up here. vault-sync loads the
     * whole index in one request instead of one lookup per file, which is what
     * keeps a full sync inside the 50-subrequest ceiling.
     */
    existing?:  { id: string; blobSha: string | null } | null;
  },
): Promise<{ ingested: boolean; documentId: string }> {
  const base = `${env.SUPABASE_URL}/rest/v1`;

  let existingRow: { id: string; blobSha: string | null } | null;
  if (opts.existing !== undefined) {
    existingRow = opts.existing;
  } else {
    const lookup = await fetch(
      `${base}/orch_documents?source_uri=eq.${encodeURIComponent(opts.sourceUri)}&select=id,metadata`,
      { headers: orch(env) },
    );
    if (!lookup.ok) throw new Error(`Supabase lookup failed: ${lookup.status} ${await lookup.text()}`);
    const rows = await lookup.json() as Array<{ id: string; metadata: Record<string, unknown> | null }>;
    existingRow = rows[0] ? { id: rows[0].id, blobSha: (rows[0].metadata?.["github_blob_sha"] as string | undefined) ?? null } : null;
  }

  if (existingRow && existingRow.blobSha === opts.blobSha) {
    return { ingested: false, documentId: existingRow.id };
  }

  // Delete existing row if present (cascades to document_chunks via FK)
  if (existingRow) {
    const del = await fetch(
      `${base}/orch_documents?source_uri=eq.${encodeURIComponent(opts.sourceUri)}`,
      { method: "DELETE", headers: orch(env) },
    );
    if (!del.ok) throw new Error(`Supabase delete failed: ${del.status} ${await del.text()}`);
  }

  // Insert new document row
  const insertRes = await fetch(`${base}/orch_documents`, {
    method: "POST",
    headers: orch(env),
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
    const res = await fetch(`${base}/document_chunks`, {
      method: "POST",
      headers: orch(env),
      body: JSON.stringify(chunkRows.slice(i, i + 100)),
    });
    if (!res.ok) throw new Error(`Supabase chunk insert failed: ${res.status} ${await res.text()}`);
  }

  return { ingested: true, documentId: doc.id };
}

// ─── Remove a vault file ──────────────────────────────────────────────────────

export async function removeVaultDocument(env: Env, sourceUri: string): Promise<boolean> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/orch_documents?source_uri=eq.${encodeURIComponent(sourceUri)}`,
    { method: "DELETE", headers: orch(env) },
  );
  if (!res.ok) throw new Error(`Supabase delete vault doc failed: ${res.status}`);
  return true;
}
