import { z } from "zod";
import { defineTool } from "../../runtime/src";
import { callN8nWebhook } from "./base";

export const resumeScoringInputSchema = z.object({
  jobId: z.string().uuid(),
  resumeStoragePath: z.string().describe("Supabase Storage path to the resume PDF"),
  candidateId: z.string().optional(),
});

export const resumeScoringOutputSchema = z.object({
  queueItemId: z.string().uuid(),
  status: z.enum(["queued", "processing", "done", "error"]),
  overallScore: z.number().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
});

// n8n Resume Scoring workflow webhook path is a UUID — fetch dynamically or hardcode
const RESUME_SCORING_WEBHOOK_PATH = "00077e0c-97aa-4476-a138-ed7941bf4eef";

export const resumeScoring = defineTool({
  name: "resumeScoring",
  inputSchema: resumeScoringInputSchema,
  outputSchema: resumeScoringOutputSchema,
  async run(ctx, input) {
    return callN8nWebhook(
      ctx,
      RESUME_SCORING_WEBHOOK_PATH,
      input,
      ctx.idempotencyKey("resume-scoring", input.jobId, input.resumeStoragePath),
    );
  },
});
