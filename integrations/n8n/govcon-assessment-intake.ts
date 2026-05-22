import { z } from "zod";
import { defineTool } from "../../runtime/src";
import { callN8nWebhookMultipart } from "./base";

export const govconAssessmentIntakeInputSchema = z.object({
  opportunityId: z.string().uuid().describe("Supabase opportunity row ID — sent as company_profile_id"),
  opportunityName: z.string().optional().describe("Opportunity title or name"),
  summaryText: z.string().optional().describe("Analyst summary or solicitation abstract"),
  notes: z.string().optional().describe("Extra analyst notes or context"),
  solicitationPdfBase64: z.string().optional().describe("Base64-encoded solicitation PDF (single file only)"),
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
    const taskId = crypto.randomUUID();

    const fields: Record<string, string> = {
      task_id: taskId,
      company_profile_id: input.opportunityId,
      source_type: "agent",
    };
    if (input.opportunityName) fields.opportunity_name = input.opportunityName;
    if (input.summaryText) fields.summary_text = input.summaryText;
    if (input.notes) fields.extra_text = input.notes;

    const files = input.solicitationPdfBase64
      ? [{ fieldName: "files", filename: "solicitation.pdf", base64: input.solicitationPdfBase64 }]
      : [];

    return callN8nWebhookMultipart(
      ctx,
      "govcon-assessment-intake",
      fields,
      files,
      ctx.idempotencyKey("govcon-assessment-intake", input.opportunityId),
    );
  },
});
