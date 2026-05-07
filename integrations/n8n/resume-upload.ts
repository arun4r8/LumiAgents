import { z } from "zod";
import { defineTool } from "../../runtime/src";
import type { RunContext } from "../../runtime/src/types";

export const resumeUploadInputSchema = z.object({
  resumeStoragePath: z.string().describe("Supabase Storage path to the resume PDF"),
  formattingCriteria: z.string().default("ATS-friendly, two pages max"),
  targetRole: z.string().describe("Target job role or industry"),
});

export const resumeUploadOutputSchema = z.object({
  formattedResumePath: z.string().describe("Storage path to the formatted PDF"),
  contentType: z.literal("application/pdf"),
});

export const resumeUpload = defineTool({
  name: "resumeUpload",
  inputSchema: resumeUploadInputSchema,
  outputSchema: resumeUploadOutputSchema,
  async run(ctx: RunContext, input) {
    // Fetch the PDF from Supabase Storage
    const pdfRes = await ctx.fetch(
      `${ctx.env.SUPABASE_URL}/storage/v1/object/${input.resumeStoragePath}`,
      {
        headers: {
          apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );

    if (!pdfRes.ok) {
      throw new Error(`Failed to fetch resume from storage: ${pdfRes.status}`);
    }

    const pdfBlob = await pdfRes.blob();

    // Send to n8n resume-upload webhook as multipart
    const form = new FormData();
    form.append("file", pdfBlob, "resume.pdf");
    form.append("formattingCriteria", input.formattingCriteria);
    form.append("targetRole", input.targetRole);

    const res = await ctx.fetch("https://lumiture.app.n8n.cloud/webhook/resume-upload", {
      method: "POST",
      headers: {
        "X-Idempotency-Key": ctx.idempotencyKey("resume-upload", input.resumeStoragePath),
        ...(ctx.env.N8N_WEBHOOK_SECRET ? { "X-Webhook-Secret": ctx.env.N8N_WEBHOOK_SECRET } : {}),
      },
      body: form,
    });

    if (!res.ok) {
      throw new Error(`Resume formatting failed: ${res.status} ${await res.text()}`);
    }

    // n8n returns the formatted PDF — upload it to storage
    const formattedPdf = await res.blob();
    const outputPath = input.resumeStoragePath.replace(/\.pdf$/i, "-formatted.pdf");

    const uploadRes = await ctx.fetch(
      `${ctx.env.SUPABASE_URL}/storage/v1/object/${outputPath}`,
      {
        method: "POST",
        headers: {
          apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/pdf",
        },
        body: formattedPdf,
      },
    );

    if (!uploadRes.ok) {
      throw new Error(`Failed to upload formatted resume: ${uploadRes.status}`);
    }

    return {
      formattedResumePath: outputPath,
      contentType: "application/pdf" as const,
    };
  },
});
