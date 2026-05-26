import { z } from "zod";
import { defineTool } from "../../runtime/src";
import { directResumeIntake } from "./resume-intake";

export const resumeScorerInputSchema = z.object({
  jobDescription: z.string().describe("Role title and requirements to score against"),
  pdfBase64s: z.array(z.string()).min(1).describe("Base64-encoded PDF résumés (batch)"),
});

export const resumeScorerOutputSchema = z.object({
  jobId: z.string().uuid(),
  submitted: z.number(),
});

// Uploads PDFs directly to Supabase Storage and inserts resume_jobs / agent_tasks /
// resume_queue rows. Bypasses the n8n intake webhook so concurrent orchestration runs
// never contend for n8n's execution slots during intake. The scheduled n8n Worker
// workflow picks up queue items independently.
export const resumeScorer = defineTool({
  name: "resumeScorer",
  inputSchema: resumeScorerInputSchema,
  outputSchema: resumeScorerOutputSchema,
  async run(ctx, input) {
    const jobId = crypto.randomUUID();
    return directResumeIntake(ctx, {
      jobId,
      jobDescription: input.jobDescription,
      pdfBase64s: input.pdfBase64s,
    });
  },
});
