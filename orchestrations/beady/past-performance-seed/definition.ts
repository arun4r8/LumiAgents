import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { pastPerformanceSeeder } from "./tools";

export const inputSchema = z.object({
  pastPerformanceId: z.string().uuid().describe("Supabase past_performance row ID to embed"),
});

export const outputSchema = z.object({
  success: z.boolean(),
  vectorsCreated: z.number().optional(),
});

export default defineOrchestration({
  name: "beady/past-performance-seed",
  version: 1,
  description:
    "Embed a past performance record into n8n's pgvector RAG so it is available for GovCon assessments",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },
  async run(ctx, input) {
    return step(ctx, "n8n-embed", () =>
      pastPerformanceSeeder(ctx, { pastPerformanceId: input.pastPerformanceId }),
    );
  },
});
