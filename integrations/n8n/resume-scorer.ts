import { z } from "zod";
import { defineTool } from "../../runtime/src";
import { callN8nWebhook } from "./base";

export const resumeScorerInputSchema = z.object({
  jobDescription: z.string().describe("Role title and requirements to score against"),
  pdfBase64s: z.array(z.string()).min(1).describe("Base64-encoded PDF résumés (batch)"),
  jobId: z.string().uuid().optional().describe("Existing resume_jobs row to append results to"),
});

export const resumeScorerOutputSchema = z.object({
  jobId: z.string().uuid(),
  submitted: z.number(),
});

export const resumeScorer = defineTool({
  name: "resumeScorer",
  inputSchema: resumeScorerInputSchema,
  outputSchema: resumeScorerOutputSchema,
  async run(ctx, input) {
    return callN8nWebhook(
      ctx,
      "resume-scorer",
      input,
      ctx.idempotencyKey("resume-scorer", input.jobDescription.slice(0, 40)),
    );
  },
});
