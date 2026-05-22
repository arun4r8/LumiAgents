import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { resumeScorer } from "../../../integrations/n8n/resume-scorer";

export const inputSchema = z.object({
  jobDescription: z.string().describe("Role title and requirements to score against"),
  pdfBase64s: z.array(z.string()).min(1).describe("Base64-encoded PDF résumés — injected automatically from chat attachments"),
});

export const outputSchema = z.object({
  jobId: z.string().uuid(),
  submitted: z.number(),
});

export default defineOrchestration({
  name: "angie/resume-scoring",
  version: 1,
  triggerMode: "agent",
  description: "Batch-score candidate résumés (PDF) against a job description via the AI pipeline. Supports multiple résumés per run.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },
  async run(ctx, input) {
    // Split large batches into chunks so each n8n webhook call stays under ~20MB.
    // Subsequent chunks reuse the jobId returned by the first call so all résumés
    // land in the same scoring job.
    const CHUNK = 25;
    let firstJobId: string | undefined;
    let totalSubmitted = 0;

    for (let i = 0; i < input.pdfBase64s.length; i += CHUNK) {
      const chunk = input.pdfBase64s.slice(i, i + CHUNK);
      const result = await step(ctx, `n8n-resume-scorer-${Math.floor(i / CHUNK)}`, () =>
        resumeScorer(ctx, {
          jobDescription: input.jobDescription,
          pdfBase64s: chunk,
        }),
      );
      if (firstJobId === undefined) firstJobId = result.jobId;
      totalSubmitted += result.submitted;
    }

    return { jobId: firstJobId!, submitted: totalSubmitted };
  },
});
