import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";

// Angie's "who scored well recently" tool. Read-only; reads resume_results (one row
// per scored résumé, written by angie/resume-scoring) joined to its parent
// resume_jobs row for the role description, ranked by overall_score.

export const inputSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  sinceHours: z.number().min(1).max(24 * 30).default(24),
});

export const outputSchema = z.object({
  candidates: z.array(z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    role: z.string().nullable(),
    overallScore: z.number().nullable(),
    school: z.string().nullable(),
    gradYear: z.string().nullable(),
    jobDescription: z.string().nullable(),
    createdAt: z.string(),
  })),
});

export default defineOrchestration({
  name: "angie/recent-resume-jobs",
  version: 1,
  triggerMode: "agent",
  description:
    "Top-scored candidates from résumé scoring jobs run recently, ranked by overall score. Angie's 'who scored well from today's batch' tool.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },
  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const env = ctx.env;
    return step(ctx, "fetch-recent", async () => {
      const since = new Date(Date.now() - input.sinceHours * 3_600_000).toISOString();
      const params = new URLSearchParams({
        select: "name,email,role,overall_score,school,grad_year,created_at,resume_jobs(job)",
        created_at: `gte.${since}`,
        status: "eq.done",
        order: "overall_score.desc,created_at.desc",
        limit: String(input.limit),
      });
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/resume_results?${params}`,
        { headers: sbHeaders(env) },
      );
      if (!res.ok) throw new Error(`Supabase GET resume_results → ${res.status}: ${await res.text()}`);
      const rows = (await res.json()) as Array<{
        name: string | null;
        email: string | null;
        role: string | null;
        overall_score: number | null;
        school: string | null;
        grad_year: string | null;
        created_at: string;
        resume_jobs: { job: string | null } | null;
      }>;

      return {
        candidates: rows.map((r) => ({
          name: r.name,
          email: r.email,
          role: r.role,
          overallScore: r.overall_score,
          school: r.school,
          gradYear: r.grad_year,
          jobDescription: r.resume_jobs?.job ?? null,
          createdAt: r.created_at,
        })),
      };
    });
  },
});
