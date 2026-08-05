import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { queryDocuments } from "@/runtime/agents/document-rag";
import { scopeForAgent } from "@/runtime/agents/knowledge-access";

// Dewey answers questions over the shared central knowledge base. It reads the
// `shared` corpus plus its own `dewey` corpus, internal sensitivity only. This is the same
// scoped retrieval every agent uses, exposed as Dewey's primary tool.

export const inputSchema = z.object({
  question: z.string().min(1).describe("Natural-language question to answer from the shared knowledge base."),
  minSimilarity: z.number().min(0).max(1).default(0.4).describe("Minimum similarity threshold for retrieval."),
  maxChunks: z.number().int().min(1).max(20).default(8).describe("Max document chunks to retrieve."),
});

export const outputSchema = z.object({
  answer: z.string(),
  sources: z.array(z.object({
    sourceName: z.string(),
    chunkIndex: z.number(),
    similarity: z.number(),
  })),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export default defineOrchestration({
  name: "dewey/knowledge-search",
  version: 1,
  triggerMode: "agent",
  // #127: queryDocuments = embed + match_document_chunks (read-only RPC) + one Claude
  // call. No writes, no await_approval.
  readOnly: true,
  description:
    "Answer a question from the shared central knowledge base (RAG over the 'shared' corpus). Dewey's primary tool.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },
  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const scope = scopeForAgent("dewey");
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
