import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { ingestDocument, queryDocuments } from "@/runtime/agents/document-rag";
import { scopeForAgent } from "@/runtime/agents/knowledge-access";

// ─── Ingest orchestration ─────────────────────────────────────────────────────

export const ingestInputSchema = z.object({
  sourceName: z.string().describe("Human-readable label for the document"),
  sourceKind: z.enum(["pdf", "text", "csv", "url"]),
  content: z.string().min(1).describe("Extracted text content of the document"),
  storagePath: z.string().optional().describe("Supabase Storage path if file-backed"),
  metadata: z.record(z.unknown()).optional(),
  corpus: z.string().optional().describe("Ownership/visibility corpus. 'shared' (default, every agent) or an agent slug for a private corpus."),
  sensitivity: z.enum(["internal", "restricted"]).optional().describe("'internal' (default, team-usable) or 'restricted' (ops-only; never surfaces in agent retrieval)."),
});

export const ingestOutputSchema = z.object({
  documentId: z.string().uuid(),
  chunkCount: z.number(),
  charCount: z.number(),
});

export const documentIngest = defineOrchestration({
  name: "patch/document-ingest",
  version: 1,
  description: "Ingest a document into the RAG knowledge base: chunks, embeds, and stores it",
  inputSchema: ingestInputSchema,
  outputSchema: ingestOutputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },
  async run(ctx, input) {
    return step(ctx, "ingest-and-embed", () =>
      ingestDocument(ctx.env, {
        sourceName: input.sourceName,
        sourceKind: input.sourceKind,
        content: input.content,
        ...(input.storagePath !== undefined ? { storagePath: input.storagePath } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        ...(input.corpus !== undefined ? { corpus: input.corpus } : {}),
        ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
      }),
    );
  },
});

// ─── Query orchestration ──────────────────────────────────────────────────────

export const queryInputSchema = z.object({
  question: z.string().min(1).describe("Natural language question about company documents"),
  minSimilarity: z.number().min(0).max(1).default(0.4).describe("Minimum similarity threshold for retrieval"),
  maxChunks: z.number().int().min(1).max(20).default(8).describe("Max document chunks to retrieve"),
});

export const queryOutputSchema = z.object({
  answer: z.string(),
  sources: z.array(z.object({
    sourceName: z.string(),
    chunkIndex: z.number(),
    similarity: z.number(),
  })),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export const documentQuery = defineOrchestration({
  name: "patch/document-query",
  version: 1,
  description: "Answer a question using the company document knowledge base (RAG)",
  inputSchema: queryInputSchema,
  outputSchema: queryOutputSchema,
  access: {
    triggerableBy: ["role:ops", "role:enduser"],
    visibleTo: ["role:ops", "role:enduser"],
  },
  async run(ctx, input) {
    const scope = scopeForAgent("patch");
    return step(ctx, "retrieve-and-answer", () =>
      queryDocuments(ctx.env, {
        question: input.question,
        minSimilarity: input.minSimilarity,
        maxChunks: input.maxChunks,
        allowedCorpora: scope.allowedCorpora,
        includeRestricted: scope.includeRestricted,
      }),
    );
  },
});
