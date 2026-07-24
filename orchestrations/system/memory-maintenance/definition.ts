import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";

export const inputSchema = z.object({
  retentionDays: z
    .number()
    .int()
    .min(1)
    .default(180)
    .describe("Delete conversations idle longer than this (cascades to messages + memory chunks)."),
});

export const outputSchema = z.object({
  purgedConversations: z.number(),
});

// Daily memory upkeep. Calls the retention purge so transcripts and their embedded
// memory don't accumulate forever; the cascade removes messages + memory_chunks.
export default defineOrchestration({
  name: "system/memory-maintenance",
  version: 1,
  description:
    "Daily agent-memory upkeep: purge conversations idle beyond the retention window (cascades to messages and memory chunks).",
  cron: "30 12 * * *",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const purged = await step(ctx, "purge-expired-conversations", async () => {
      const res = await ctx.fetch(`${ctx.env.SUPABASE_URL}/rest/v1/rpc/purge_expired_conversations`, {
        method: "POST",
        headers: sbHeaders(ctx.env, { profile: "orchestration" }),
        body: JSON.stringify({ p_days: input.retentionDays }),
      });
      if (!res.ok) throw new Error(`purge_expired_conversations → ${res.status}: ${await res.text()}`);
      const n = (await res.json()) as number;
      return typeof n === "number" ? n : 0;
    });

    return { purgedConversations: purged };
  },
});
