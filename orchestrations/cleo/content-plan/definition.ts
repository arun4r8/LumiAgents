import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import type { Env } from "@/runtime";
import { planContentIdeas } from "../../../integrations/anthropic/content";

// Propose a run of content-calendar ideas from a theme and insert them as 'idea' rows
// for the team to review, edit, and draft. Grounded in the company profile so ideas
// stay relevant to real capabilities. Spaces release dates out weekly from startDate.

export const inputSchema = z.object({
  theme: z.string().min(1).describe("The theme or campaign to generate post ideas around."),
  count: z.number().int().min(1).max(20).default(5).describe("How many ideas to generate."),
  startDate: z.string().optional().describe("ISO date to start scheduling ideas from (default: today)."),
  channel: z.string().default("linkedin").describe("Channel for the ideas."),
});

export const outputSchema = z.object({
  inserted: z.number(),
  topics: z.array(z.string()),
});

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

function isoDatePlusWeeks(start: Date, weeks: number): string {
  const d = new Date(start.getTime());
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

export default defineOrchestration({
  name: "cleo/content-plan",
  version: 1,
  triggerMode: "agent",
  description:
    "Propose a run of content-calendar ideas from a theme and insert them as idea rows (weekly cadence) for the team to approve.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },
  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const env = ctx.env;

    const companyProfile = await step(ctx, "load-profile", async () => {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/company_profiles?select=*&limit=1`, { headers: sbHeaders(env) });
      if (!res.ok) throw new Error(`load company_profiles → ${res.status}`);
      const rows = (await res.json()) as Array<{ profile?: unknown }>;
      return (rows[0]?.profile ?? rows[0] ?? {}) as unknown;
    });

    const ideas = await step(ctx, "generate-ideas", async () =>
      planContentIdeas(env, { theme: input.theme, count: input.count, companyProfile }, ctx.model),
    );

    const inserted = await step(ctx, "insert-ideas", async () => {
      if (ideas.length === 0) return [] as string[];
      const start = input.startDate ? new Date(input.startDate) : new Date();
      const base = isNaN(start.getTime()) ? new Date() : start;
      const rows = ideas.map((idea, i) => ({
        release_date: isoDatePlusWeeks(base, i),
        topic: idea.topic,
        channel: input.channel,
        asset_type: idea.asset_type,
        description: idea.description,
        status: "idea",
      }));
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/content_calendar`, {
        method: "POST",
        headers: sbHeaders(env, { Prefer: "return=minimal" }),
        body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`insert content_calendar → ${res.status}: ${await res.text()}`);
      return ideas.map((i) => i.topic);
    });

    return { inserted: inserted.length, topics: inserted };
  },
});
