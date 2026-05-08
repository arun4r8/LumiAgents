import { z } from "zod";
import { defineOrchestration, step, llm_decide, llm_extract } from "@/runtime";

export const inputSchema = z.object({
  opportunityId: z.string().uuid().describe("Supabase opportunity row ID — must exist before calling this"),
  sourceUrl: z.string().url().optional().describe("SAM.gov or solicitation URL for reference"),
  notes: z.string().optional().describe("Any additional context for the assessment"),
});

export const outputSchema = z.object({
  assessmentId: z.string().uuid(),
  score: z.number().describe("0–100 qualification score"),
  recommendation: z.enum(["go", "no-go", "conditional"]),
  executiveMemo: z.string().describe("Full executive memo text"),
  requiresReview: z.boolean().describe("True if a human should review before proceeding"),
});

// ─── Lumiture capability profile (injected into the assessment prompt) ────────

const LUMITURE_PROFILE = `
Lumiture LLC — Government Contracting Profile
=============================================
Core services:
  • Database management & modernisation (PostgreSQL, Oracle, SQL Server, cloud DBs)
  • Data engineering, ETL pipelines, analytics platforms
  • AI/ML integration and agentic workflow automation
  • Cloud infrastructure (AWS GovCloud, Azure Government, GCP)

Contract vehicles & certifications:
  • Small Business (SB) — active registration
  • NAICS primaries: 541512, 541511, 541519, 541330
  • No current 8(a), SDVOSB, or WOSB certifications
  • Cleared staff available (Secret level); no TS/SCI pool at this time

Sweet spot:
  • Database modernisation / migration for federal agencies
  • Managed database services (DBA-as-a-service)
  • Agentic AI platforms for ops automation
  • Contract size: $500K–$10M; larger with a prime

Avoid / red flags:
  • Construction, physical security, logistics
  • Requires TS/SCI cleared staff majority
  • Dominated by large-business incumbents with no subcontracting plan
  • NAICS outside IT/engineering without a clear rationale
  • Mandatory 8(a) or SDVOSB set-asides we cannot bid directly
`.trim();

// ─── Assessment scoring schema ────────────────────────────────────────────────

const assessmentSchema = z.object({
  score: z.number().int().min(0).max(100).describe("Overall qualification score 0–100"),
  recommendation: z
    .enum(["go", "no-go", "conditional"])
    .describe("go = pursue; no-go = pass; conditional = pursue only if a specific condition is met"),
  executiveMemo: z
    .string()
    .describe(
      "Full executive memo in markdown. Sections: Opportunity Overview, Lumiture Fit Assessment, " +
        "Key Risks & Mitigants, Recommendation, Next Steps (if go/conditional).",
    ),
  scoringFactors: z
    .object({
      technicalFit: z
        .object({ score: z.number().int().min(0).max(25), rationale: z.string() })
        .describe("Technical alignment with our service areas (0–25)"),
      contractVehicle: z
        .object({ score: z.number().int().min(0).max(20), rationale: z.string() })
        .describe("Set-aside, NAICS, size standard alignment (0–20)"),
      competitivePosition: z
        .object({ score: z.number().int().min(0).max(20), rationale: z.string() })
        .describe("Incumbent risk, teaming needs, realistic win probability (0–20)"),
      contractValue: z
        .object({ score: z.number().int().min(0).max(20), rationale: z.string() })
        .describe("Estimated value relative to our sweet spot (0–20)"),
      timeline: z
        .object({ score: z.number().int().min(0).max(15), rationale: z.string() })
        .describe("Response timeline feasibility (0–15)"),
    })
    .describe("Per-factor breakdown — must sum to overall score"),
  redFlags: z.array(z.string()).describe("Blocking or major concerns, empty if none"),
  conditions: z
    .array(z.string())
    .describe("Conditions that must be met for a 'conditional' recommendation, empty otherwise"),
});

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "beady/govcon-assessment",
  version: 2,
  description:
    "Assess a government contracting opportunity and produce a scored go/no-go recommendation with executive memo — fully in-runtime, no n8n dependency",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input) {
    // ── Step 1: Fetch opportunity from Supabase ───────────────────────────────
    const opportunity = await step(ctx, "fetch-opportunity", async () => {
      const res = await ctx.fetch(
        `${ctx.env.SUPABASE_URL}/rest/v1/opportunities?id=eq.${input.opportunityId}&select=*&limit=1`,
        {
          headers: {
            apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        },
      );
      if (!res.ok) throw new Error(`Failed to fetch opportunity: ${res.status}`);
      const rows = (await res.json()) as Record<string, unknown>[];
      if (!rows[0]) throw new Error(`Opportunity ${input.opportunityId} not found`);
      return rows[0];
    });

    // ── Step 2: Run the full assessment via llm_extract ───────────────────────
    const assessment = await llm_extract(ctx, {
      name: "assess-opportunity",
      prompt: `
You are Beady, Lumiture's GovCon intelligence AI. Assess the following contract opportunity
against Lumiture's profile and produce a structured evaluation.

${LUMITURE_PROFILE}

Be critical and specific. If the opportunity is clearly out of scope (wrong NAICS, TS/SCI
required, large-business only), say so clearly and score accordingly. The executive memo
should be professional, concise (400–600 words), and ready to send to leadership.

${input.notes ? `\nAdditional context from the operator: ${input.notes}` : ""}
      `.trim(),
      input: {
        opportunity,
        sourceUrl: input.sourceUrl ?? null,
      },
      schema: assessmentSchema,
    });

    // ── Step 3: Persist assessment to govcon_assessments ─────────────────────
    const assessmentId = await step(ctx, "save-assessment", async () => {
      const res = await ctx.fetch(
        `${ctx.env.SUPABASE_URL}/rest/v1/govcon_assessments`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            opportunity_id: input.opportunityId,
            run_id: ctx.runId,
            score: assessment.score,
            go_no_go: assessment.recommendation,
            executive_memo: assessment.executiveMemo,
            scoring_factors: assessment.scoringFactors,
            requires_review: false, // updated in step 5
            notes: input.notes ?? null,
          }),
        },
      );
      if (!res.ok) throw new Error(`Failed to save assessment: ${res.status} ${await res.text()}`);
      const [row] = (await res.json()) as Array<{ id: string }>;
      return row?.id ?? crypto.randomUUID();
    });

    // ── Step 4: Update opportunity scoring columns ────────────────────────────
    // Keep the opportunities table in sync so dashboards can query fit_score directly.
    await step(ctx, "update-opportunity-score", async () => {
      // Map 0-100 → 1-10 and go/no-go/conditional → pursue/monitor/pass
      const fitScore = Math.round(assessment.score / 10);
      const recommendation =
        assessment.recommendation === "go"
          ? "pursue"
          : assessment.recommendation === "conditional"
            ? "monitor"
            : "pass";

      const res = await ctx.fetch(
        `${ctx.env.SUPABASE_URL}/rest/v1/opportunities?id=eq.${input.opportunityId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            fit_score: fitScore,
            fit_reason: assessment.scoringFactors.technicalFit.rationale,
            red_flags: assessment.redFlags.join("; ") || null,
            recommendation,
            last_scored_at: new Date().toISOString(),
          }),
        },
      );
      if (!res.ok) throw new Error(`Failed to update opportunity: ${res.status}`);
    });

    // ── Step 5: Decide if human review is needed ──────────────────────────────
    const needsReview = await llm_decide(ctx, {
      name: "should-route-to-review",
      prompt:
        "Based on the assessment score and recommendation, does this opportunity require human review before a final pursuit decision?",
      input: {
        score: assessment.score,
        recommendation: assessment.recommendation,
        redFlags: assessment.redFlags,
        conditions: assessment.conditions,
      },
      options: ["yes", "no"] as const,
    });

    // Backfill requires_review on the saved assessment row
    if (needsReview === "yes") {
      await step(ctx, "flag-requires-review", async () => {
        await ctx.fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/govcon_assessments?id=eq.${assessmentId}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
            },
            body: JSON.stringify({ requires_review: true }),
          },
        );
      });
    }

    return {
      assessmentId,
      score: assessment.score,
      recommendation: assessment.recommendation,
      executiveMemo: assessment.executiveMemo,
      requiresReview: needsReview === "yes",
    };
  },
});
