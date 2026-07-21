import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { upsertVaultDocument } from "../../../runtime/src/agents/vault-sync";

export const inputSchema = z.object({
  pastPerformanceId: z.string().uuid().describe("Supabase past_performance row ID to embed"),
});

export const outputSchema = z.object({
  success: z.boolean(),
  ingested: z.boolean().describe("True if embedded, false if content was unchanged"),
  documentId: z.string().optional(),
});

export default defineOrchestration({
  name: "beady/past-performance-seed",
  version: 1,
  triggerMode: "agent",
  description:
    "Embed a past performance record into the shared RAG corpus (orchestration.document_chunks) " +
    "so it is searchable by document-rag and govcon assessments.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo:     ["role:ops"],
  },

  async run(ctx, input) {
    return step(ctx, "embed-past-performance", async () => {
      // Fetch the record directly from Supabase
      const res = await ctx.fetch(
        `${ctx.env.SUPABASE_URL}/rest/v1/past_performance?id=eq.${encodeURIComponent(input.pastPerformanceId)}&select=*`,
        {
          headers: {
            apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        },
      );
      if (!res.ok) throw new Error(`Supabase past_performance fetch failed: ${await res.text()}`);

      const rows = await res.json() as Array<Record<string, unknown>>;
      const record = rows[0];
      if (!record) throw new Error(`Past performance record not found: ${input.pastPerformanceId}`);

      // Format as searchable markdown
      const tags = Array.isArray(record["relevance_tags"])
        ? (record["relevance_tags"] as string[]).join(", ")
        : typeof record["relevance_tags"] === "string"
          ? record["relevance_tags"]
          : null;

      const content = [
        `# ${record["title"] ?? "Past Performance Record"}`,
        `**Customer:** ${record["customer"] ?? "-"}`,
        `**Domain:** ${record["domain"] ?? "-"}`,
        `**Contract Value:** ${record["contract_value"] ?? "-"}`,
        `**Period of Performance:** ${record["period_of_performance"] ?? "-"}`,
        tags ? `**Tags:** ${tags}` : null,
        ``,
        `## Scope Summary`,
        record["scope_summary"] ?? "",
      ].filter(Boolean).join("\n");

      // Use updated_at as the content hash so edits trigger re-embedding
      const blobSha = String(record["updated_at"] ?? record["created_at"] ?? input.pastPerformanceId);

      const { ingested, documentId } = await upsertVaultDocument(ctx.env, {
        sourceUri:  `past-performance:${input.pastPerformanceId}`,
        sourceName: (record["title"] as string | null) ?? `Past Performance ${input.pastPerformanceId.slice(0, 8)}`,
        content,
        blobSha,
        metadata: {
          kind:                 "past_performance",
          past_performance_id:  input.pastPerformanceId,
          customer:             record["customer"],
          domain:               record["domain"],
        },
      });

      return { success: true, ingested, documentId };
    });
  },
});
