import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { govconAssessmentIntake } from "./tools";

export const inputSchema = z.object({
  opportunityId: z.string().uuid().describe("Supabase opportunity row ID"),
  sourceUrl: z.string().url().optional().describe("SAM.gov or solicitation URL"),
  notes: z.string().optional().describe("Analyst notes or context for the assessment"),
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
        ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      }),
    );
  },
});
