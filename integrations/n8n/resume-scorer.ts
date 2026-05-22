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

// n8n runs the scoring pipeline asynchronously and returns HTTP 200 with an empty body.
// We generate the jobId locally so orchestration steps can correlate results without
// waiting for n8n to respond.
const RESUME_SCORER_WEBHOOK = "00077e0c-97aa-4476-a138-ed7941bf4eef";

export const resumeScorer = defineTool({
  name: "resumeScorer",
  inputSchema: resumeScorerInputSchema,
  outputSchema: resumeScorerOutputSchema,
  async run(ctx, input) {
    const jobId = input.jobId ?? crypto.randomUUID();
    await callN8nWebhook(
      ctx,
      RESUME_SCORER_WEBHOOK,
      {
        task_id: jobId,
        roleKey: input.jobDescription,
        fileCount: input.pdfBase64s.length,
        pdfBase64s: input.pdfBase64s,
      },
      ctx.idempotencyKey("resume-scorer", jobId),
    );
    return { jobId, submitted: input.pdfBase64s.length };
  },
});
