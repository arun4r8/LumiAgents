import { z } from "zod";
import { defineTool } from "../../runtime/src";
import { callN8nWebhook } from "./base";

export const pastPerformanceSeedInputSchema = z.object({
  pastPerformanceId: z.string().uuid().describe("Supabase past_performance row ID to embed"),
});

export const pastPerformanceSeedOutputSchema = z.object({
  success: z.boolean(),
  vectorsCreated: z.number().optional(),
});

export const pastPerformanceSeeder = defineTool({
  name: "pastPerformanceSeeder",
  inputSchema: pastPerformanceSeedInputSchema,
  outputSchema: pastPerformanceSeedOutputSchema,
  async run(ctx, input) {
    return callN8nWebhook(
      ctx,
      "past-performance-seeder",
      input,
      ctx.idempotencyKey("past-performance-seeder", input.pastPerformanceId),
    );
  },
});
