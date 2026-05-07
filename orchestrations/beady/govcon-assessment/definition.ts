import { z } from "zod";
import { defineOrchestration, step, llm_decide, llm_extract } from "@/runtime";
import { govconAssessmentIntake } from "./tools";

export const inputSchema = z.object({
  opportunityId: z.string().uuid().describe("Supabase opportunity row ID — must exist before calling this"),
  sourceUrl: z.string().url().optional().describe("SAM.gov or solicitation URL"),
  notes: z.string().optional().describe("Any additional context for the assessors"),
});

export const outputSchema = z.object({
  assessmentId: z.string().uuid(),
  score: z.number().describe("0–100 qualification score"),
  recommendation: z.enum(["go", "no-go", "conditional"]),
  executiveMemo: z.string().describe("Full executive memo text"),
  requiresReview: z.boolean().describe("True if a human should review before proceeding"),
});

export default defineOrchestration({
  name: "beady/govcon-assessment",
  version: 1,
  description: "Assess a government contracting opportunity and produce a go/no-go recommendation with executive memo",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input) {
    // Step 1: Run the n8n assessment workflow
    const assessment = await step(ctx, "run-n8n-assessment", () =>
      govconAssessmentIntake(ctx, {
        opportunityId: input.opportunityId,
        sourceUrl: input.sourceUrl,
        notes: input.notes,
      }),
    );

    // Step 2: Decide if this needs human review (conditional scores get a second pair of eyes)
    const needsReview = await llm_decide(ctx, {
      name: "should-route-to-review",
      prompt: "Based on the assessment score and recommendation, does this opportunity require human review before a final decision is made?",
      input: {
        score: assessment.score,
        recommendation: assessment.goNoGo,
        executiveMemoPreview: assessment.executiveMemo.slice(0, 500),
      },
      options: ["yes", "no"],
    });

    return {
      assessmentId: assessment.assessmentId,
      score: assessment.score,
      recommendation: assessment.goNoGo,
      executiveMemo: assessment.executiveMemo,
      requiresReview: needsReview === "yes",
    };
  },
});
