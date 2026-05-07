import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { resumeUpload } from "./tools";

export const inputSchema = z.object({
  resumeStoragePath: z.string().describe("Supabase Storage path to the uploaded resume PDF"),
  formattingCriteria: z.string().default("ATS-friendly, clear section headers, two pages max"),
  targetRole: z.string().describe("Job title or role being applied for"),
  candidateId: z.string().optional().describe("Candidate ID if already in the system"),
});

export const outputSchema = z.object({
  formattedResumePath: z.string().describe("Storage path to the Claude-formatted PDF"),
  contentType: z.literal("application/pdf"),
});

export default defineOrchestration({
  name: "angie/resume-formatting",
  version: 1,
  description: "Format a resume to Lumiture's standard template using Claude — ATS-optimised, role-targeted",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops", "role:hr"],
    visibleTo: ["role:ops", "role:hr"],
  },
  async run(ctx, input) {
    return step(ctx, "format-resume", () =>
      resumeUpload(ctx, {
        resumeStoragePath: input.resumeStoragePath,
        formattingCriteria: input.formattingCriteria,
        targetRole: input.targetRole,
      }),
    );
  },
});
