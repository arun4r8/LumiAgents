import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { govconAssessmentIntake } from "./tools";

export const inputSchema = z.object({
  opportunityId: z.string().uuid().describe("Supabase opportunity row ID"),
  opportunityName: z.string().optional().describe("Opportunity title or name — helps n8n label the assessment"),
  summaryText: z.string().optional().describe("Solicitation abstract or opportunity summary"),
  notes: z.string().optional().describe("Analyst notes or extra context for the assessment"),
  solicitationPdfBase64: z.string().optional().describe("Base64-encoded solicitation PDF — injected automatically from chat attachments (single file only)"),
});

export const outputSchema = z.object({
  assessmentId: z.string().uuid(),
  score: z.number(),
  goNoGo: z.enum(["go", "no-go", "conditional"]),
  executiveMemo: z.string(),
});

export default defineOrchestration({
  name: "beady/govcon-assessment",
  version: 1,
  description:
    "Run a full GovCon qualification assessment — 5-dimensional scoring with RAG against past performance and capability statements",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },
  async run(ctx, input) {
    return step(ctx, "n8n-assessment", () =>
      govconAssessmentIntake(ctx, {
        opportunityId: input.opportunityId,
        ...(input.opportunityName !== undefined ? { opportunityName: input.opportunityName } : {}),
        ...(input.summaryText !== undefined ? { summaryText: input.summaryText } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.solicitationPdfBase64 !== undefined ? { solicitationPdfBase64: input.solicitationPdfBase64 } : {}),
      }),
    );
  },
});
