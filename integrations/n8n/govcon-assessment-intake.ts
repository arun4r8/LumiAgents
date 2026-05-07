import { z } from "zod";
import { defineTool } from "../../runtime/src";
import { callN8nWebhook } from "./base";

export const govconAssessmentIntakeInputSchema = z.object({
  opportunityId: z.string().uuid().describe("Supabase opportunity row ID"),
  sourceUrl: z.string().url().optional().describe("SAM.gov or solicitation URL"),
  notes: z.string().optional(),
});

export const govconAssessmentIntakeOutputSchema = z.object({
  assessmentId: z.string().uuid(),
  score: z.number(),
  goNoGo: z.enum(["go", "no-go", "conditional"]),
  executiveMemo: z.string(),
});

export const govconAssessmentIntake = defineTool({
  name: "govconAssessmentIntake",
  inputSchema: govconAssessmentIntakeInputSchema,
  outputSchema: govconAssessmentIntakeOutputSchema,
  async run(ctx, input) {
    return callN8nWebhook(
      ctx,
      "govcon-assessment-intake",
      input,
      ctx.idempotencyKey("govcon-assessment-intake", input.opportunityId),
    );
  },
});
