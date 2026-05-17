import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { resumeScorer } from "../../../integrations/n8n/resume-scorer";

export const inputSchema = z.object({
  jobDescription: z.string().describe("Role title and requirements to score against"),
  pdfBase64s: z.array(z.string()).min(1).describe("Base64-encoded PDF résumés — injected automatically from chat attachments"),
  jobId: z.string().uuid().optional().describe("Existing resume_jobs row to append to"),
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
    return step(ctx, "n8n-resume-scorer", () =>
      resumeScorer(ctx, {
        jobDescription: input.jobDescription,
        pdfBase64s: input.pdfBase64s,
        ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
      }),
    );
  },
});
