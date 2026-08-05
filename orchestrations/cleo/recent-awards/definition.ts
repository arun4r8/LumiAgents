import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";

// Cleo's "what did the award sweep just find" tool. Read-only. Same proxy pattern as
// beady/recent-opportunities: no run_id links awards rows back to the sweep run that
// touched them, so `last_scored_at` stands in (only cleo/award-sweep writes it).

export const inputSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  sinceHours: z.number().min(1).max(24 * 30).default(24),
});

export const outputSchema = z.object({
  awards: z.array(z.object({
    awardId: z.string(),
    title: z.string(),
    sponsor: z.string().nullable(),
    category: z.string().nullable(),
    awardType: z.string(),
    fitScore: z.number().nullable(),
    recommendation: z.string(),
    prestige: z.string().nullable(),
    effort: z.string().nullable(),
    applicationDeadline: z.string().nullable(),
    lastScoredAt: z.string(),
  })),
});

export default defineOrchestration({
  name: "cleo/recent-awards",
  version: 1,
  triggerMode: "agent",
  // #127: single GET against awards; no writes, no await_approval.
  readOnly: true,
  description:
    "Awards the sweep has found/touched recently, ranked by fit score. Cleo's 'what did the award sweep find' tool.",
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
        select: "award_id,title,sponsor,category,award_type,fit_score,recommendation,prestige,effort,application_deadline,last_scored_at",
        last_scored_at: `gte.${since}`,
        order: "fit_score.desc,last_scored_at.desc",
        limit: String(input.limit),
      });
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/awards?${params}`,
        { headers: sbHeaders(env) },
      );
      if (!res.ok) throw new Error(`Supabase GET awards → ${res.status}: ${await res.text()}`);
      const rows = (await res.json()) as Array<{
        award_id: string;
        title: string;
        sponsor: string | null;
        category: string | null;
        award_type: string;
        fit_score: number | null;
        recommendation: string;
        prestige: string | null;
        effort: string | null;
        application_deadline: string | null;
        last_scored_at: string;
      }>;

      return {
        awards: rows.map((r) => ({
          awardId: r.award_id,
          title: r.title,
          sponsor: r.sponsor,
          category: r.category,
          awardType: r.award_type,
          fitScore: r.fit_score,
          recommendation: r.recommendation,
          prestige: r.prestige,
          effort: r.effort,
          applicationDeadline: r.application_deadline,
          lastScoredAt: r.last_scored_at,
        })),
      };
    });
  },
});
