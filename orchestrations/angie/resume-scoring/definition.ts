import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import type { Env } from "@/runtime";
import { scoreResume, type ScoredResume } from "../../../integrations/anthropic/score-resume";

export const inputSchema = z.object({
  jobDescription: z
    .string()
    .describe("Role title / key the résumés are scored against (the 'rolekey'). 'Lumiture' scores against the built-in JD."),
  pdfBase64s: z
    .array(z.string())
    .min(1)
    .describe("Base64-encoded PDF résumés — injected automatically from chat attachments"),
});

export const outputSchema = z.object({
  jobId: z.string().uuid(),
  submitted: z.number(),
  scored: z.number(),
  failed: z.number(),
});

// ─── Supabase REST helpers (service role; runtime is trusted) ──────────────────

function sbHeaders(env: Env): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
}

async function sbInsert(env: Env, table: string, row: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(env), Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase insert ${table} → ${res.status}: ${await res.text()}`);
}

async function sbRpc(env: Env, fn: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: sbHeaders(env),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase rpc ${fn} → ${res.status}: ${await res.text()}`);
}

// ─── Result mapping (LLM keys → resume_results columns) ─────────────────────────

const clamp = (n: number): number => Math.min(10, Math.max(1, Math.round(Number(n))));

function toResultRow(jobId: string, ev: ScoredResume): Record<string, unknown> {
  return {
    job_id: jobId,
    status: "done",
    name: ev.name,
    email: ev.email,
    mobile_number: ev.number,
    location: ev.location,
    school: ev.school,
    field_of_study: ev.major,
    gpa: ev.gpa,
    grad_year: ev.gradyr,
    role: ev.role,
    technical_skills_score: clamp(ev.technical_skills_score),
    work_experience_score: clamp(ev.work_experience_score),
    academics_score: clamp(ev.academic_achievement_score),
    projects_and_research_score: clamp(ev.projects_research_score),
    leadership_and_initiative_score: clamp(ev.leadership_initiative_score),
    overall_score: clamp(ev.overall_score),
    rationale: ev.rationale,
  };
}

// ─── Orchestration ──────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "angie/resume-scoring",
  version: 1,
  triggerMode: "agent",
  description:
    "Batch-score candidate résumés (PDF) against a role. Each résumé is read and scored by Claude in one structured call; results land in resume_results and drive the dashboard progress bar.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const jobId = crypto.randomUUID();
    const total = input.pdfBase64s.length;

    await step(ctx, "create-job", async () => {
      await sbInsert(ctx.env, "resume_jobs", {
        id: jobId,
        status: "processing",
        total,
        processed: 0,
        job: input.jobDescription,
      });
      return { jobId, total };
    });

    let scored = 0;
    let failed = 0;

    // One checkpointed step per résumé: score → insert → bump progress. A failure on a
    // single résumé records a failed row and still bumps progress, so the job completes
    // instead of stalling (the old n8n flow could loop forever on one bad item).
    for (let i = 0; i < total; i++) {
      const outcome = await step(ctx, `score-${i}`, async () => {
        try {
          const ev = await scoreResume(ctx.env, {
            rolekey: input.jobDescription,
            pdfBase64: input.pdfBase64s[i]!,
            model: ctx.model,
          });
          await sbInsert(ctx.env, "resume_results", toResultRow(jobId, ev));
          await sbRpc(ctx.env, "bump_job_progress", { p_job_id: jobId });
          return { ok: true as const, name: ev.name, overall: clamp(ev.overall_score) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await sbInsert(ctx.env, "resume_results", { job_id: jobId, status: "failed", error: message }).catch(() => {});
          await sbRpc(ctx.env, "bump_job_progress", { p_job_id: jobId }).catch(() => {});
          return { ok: false as const, error: message };
        }
      });
      if (outcome.ok) scored++;
      else failed++;
    }

    return { jobId, submitted: total, scored, failed };
  },
});
