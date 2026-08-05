import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";

// Beady's "what did the sweep just find" tool. Read-only; no orchestration_id/run_id
// links opportunities rows back to the sweep run that touched them, so `last_scored_at`
// is the proxy (only beady/opportunity-sweep writes it, and it does so on every row
// it upserts or demotes) — see orchestrations/beady/opportunity-sweep/definition.ts.

export const inputSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  sinceHours: z.number().min(1).max(24 * 30).default(24),
});

export const outputSchema = z.object({
  opportunities: z.array(z.object({
    samNoticeId: z.string().nullable(),
    title: z.string().nullable(),
    agency: z.string().nullable(),
    fitScore: z.number().nullable(),
    recommendation: z.string().nullable(),
    responseDeadline: z.string().nullable(),
    lastScoredAt: z.string().nullable(),
  })),
});

export default defineOrchestration({
  name: "beady/recent-opportunities",
  version: 1,
  triggerMode: "agent",
  // #127: single GET against opportunities; no writes, no await_approval.
  readOnly: true,
  description:
    "Opportunities the sweep has touched recently, ranked by fit score. Beady's 'what did today's sweep find' tool.",
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
        select: "sam_notice_id,title,agency,fit_score,recommendation,response_deadline,last_scored_at",
        last_scored_at: `gte.${since}`,
        order: "fit_score.desc,last_scored_at.desc",
        limit: String(input.limit),
      });
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/opportunities?${params}`,
        { headers: sbHeaders(env) },
      );
      if (!res.ok) throw new Error(`Supabase GET opportunities → ${res.status}: ${await res.text()}`);
      const rows = (await res.json()) as Array<{
        sam_notice_id: string | null;
        title: string | null;
        agency: string | null;
        fit_score: number | null;
        recommendation: string | null;
        response_deadline: string | null;
        last_scored_at: string | null;
      }>;

      return {
        opportunities: rows.map((r) => ({
          samNoticeId: r.sam_notice_id,
          title: r.title,
          agency: r.agency,
          fitScore: r.fit_score,
          recommendation: r.recommendation,
          responseDeadline: r.response_deadline,
          lastScoredAt: r.last_scored_at,
        })),
      };
    });
  },
});
