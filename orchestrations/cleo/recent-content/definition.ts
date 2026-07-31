import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";

// Cleo's "what's changed in the content calendar recently" tool. Read-only.
// `updated_at` is the recency proxy — content-plan/content-draft/content-nudge/
// content-sync all touch it whenever they write a row.

export const inputSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  sinceHours: z.number().min(1).max(24 * 30).default(24),
});

export const outputSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    topic: z.string(),
    channel: z.string(),
    status: z.string(),
    releaseDate: z.string().nullable(),
    updatedAt: z.string(),
  })),
});

export default defineOrchestration({
  name: "cleo/recent-content",
  version: 1,
  triggerMode: "agent",
  description:
    "Content calendar items updated recently (drafted, advanced, or synced), most recent first. Cleo's 'what have you done in the content calendar' tool.",
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
        select: "id,topic,channel,status,release_date,updated_at",
        updated_at: `gte.${since}`,
        order: "updated_at.desc",
        limit: String(input.limit),
      });
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/content_calendar?${params}`,
        { headers: sbHeaders(env) },
      );
      if (!res.ok) throw new Error(`Supabase GET content_calendar → ${res.status}: ${await res.text()}`);
      const rows = (await res.json()) as Array<{
        id: string;
        topic: string;
        channel: string;
        status: string;
        release_date: string | null;
        updated_at: string;
      }>;

      return {
        items: rows.map((r) => ({
          id: r.id,
          topic: r.topic,
          channel: r.channel,
          status: r.status,
          releaseDate: r.release_date,
          updatedAt: r.updated_at,
        })),
      };
    });
  },
});
