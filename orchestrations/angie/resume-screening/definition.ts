import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { resumeScoring, resumeUpload } from "./tools";

export const inputSchema = z.object({
  jobId: z.string().uuid().describe("Job opening ID in Supabase"),
  resumeStoragePath: z.string().describe("Supabase Storage path to the uploaded resume PDF"),
  formattingCriteria: z.string().default("ATS-friendly, clear section headers, two pages max"),
  targetRole: z.string().describe("Job title or role being applied for"),
});

export const outputSchema = z.object({
  queueItemId: z.string().uuid(),
  overallScore: z.number().describe("0–100 resume quality score"),
  formattedResumeUrl: z.string().describe("Storage path to the Claude-formatted PDF"),
  candidateSummary: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    topStrengths: z.array(z.string()),
    concerns: z.array(z.string()),
  }),
  recommendation: z.enum(["strong-yes", "yes", "maybe", "no"]),
});

export default defineOrchestration({
  name: "angie/resume-screening",
  version: 1,
  description: "Score a resume against a job opening, format it to standard template, and produce a hiring recommendation",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops", "role:hr"],
    visibleTo: ["role:ops", "role:hr"],
  },

  async run(ctx, input) {
    // Step 1: Score the resume via n8n (extracts candidate info + scores)
    const scored = await step(ctx, "score-resume", () =>
      resumeScoring(ctx, {
        jobId: input.jobId,
        resumeStoragePath: input.resumeStoragePath,
      }),
    );

    // Step 2: Format the resume via n8n + Claude (Resume Formatting Automation)
    const formatted = await step(ctx, "format-resume", () =>
      resumeUpload(ctx, {
        resumeStoragePath: input.resumeStoragePath,
        formattingCriteria: input.formattingCriteria,
        targetRole: input.targetRole,
      }),
    );

    // Step 3: Extract a concise candidate summary + recommendation using Claude
    const summary = await llm_extract(ctx, {
      name: "extract-candidate-summary",
      prompt: "Extract a candidate summary and hiring recommendation from the resume scoring results.",
      input: {
        jobRole: input.targetRole,
        overallScore: scored.overallScore,
        candidateName: scored.name,
        candidateEmail: scored.email,
        scoringStatus: scored.status,
      },
      schema: z.object({
        name: z.string().nullable(),
        email: z.string().nullable(),
        topStrengths: z.array(z.string()).describe("2–4 top strengths based on score"),
        concerns: z.array(z.string()).describe("Key gaps or concerns"),
        recommendation: z.enum(["strong-yes", "yes", "maybe", "no"]),
      }),
    });

    return {
      queueItemId: scored.queueItemId,
      overallScore: scored.overallScore ?? 0,
      formattedResumeUrl: formatted.formattedResumePath,
      candidateSummary: summary,
      recommendation: summary.recommendation,
    };
  },
});
