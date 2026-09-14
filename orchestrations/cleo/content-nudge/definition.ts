import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { sendAlertEmail, subscriptionRecipients } from "../../../integrations/resend/alert";
import { senderFor } from "../../../integrations/resend/sender";
import { sbHeaders } from "@/runtime/utils/supabase";

// Daily nudge: surface content-calendar posts due soon that aren't drafted yet, so the
// calendar chases the team instead of sitting passive. Emails subscribers; degrades
// gracefully if no webhook is configured.

export const inputSchema = z.object({
  withinDays: z.number().int().min(1).max(30).default(3).describe("Look this many days ahead for due posts."),
});

export const outputSchema = z.object({
  dueCount: z.number(),
  alerted: z.boolean(),
});

export default defineOrchestration({
  name: "cleo/content-nudge",
  version: 1,
  description:
    "Daily nudge that emails subscribers about content-calendar posts due soon that are not yet drafted/ready.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },
  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const env = ctx.env;
    const withinDays = input.withinDays ?? 3;

    const due = await step(ctx, "find-due", async () => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + withinDays);
      const to = cutoff.toISOString().slice(0, 10);
      // Due soon (release_date <= cutoff) and not yet ready/scheduled/posted.
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/content_calendar?release_date=lte.${to}&status=in.(idea,drafting)&select=topic,release_date,status,channel&order=release_date.asc`,
        { headers: sbHeaders(env) },
      );
      if (!res.ok) throw new Error(`load content_calendar → ${res.status}: ${await res.text()}`);
      return (await res.json()) as Array<{ topic: string; release_date: string | null; status: string; channel: string }>;
    });

    const alerted = await step(ctx, "nudge", async () => {
      if (due.length === 0) return false;
      const lines = due
        .slice(0, 15)
        .map((d) => `- ${d.release_date ?? "no date"} · ${d.topic} (${d.status})`)
        .join("\n");
      const text = `Content calendar: ${due.length} post${due.length === 1 ? "" : "s"} due within ${withinDays} days still not drafted:\n\n${lines}\n\nDraft them with Cleo from the Content Calendar page.`;

      // A reminder about content, so it goes to the business digests' readers, not
      // to the operational alert list. Named explicitly: an unfiltered lookup would
      // now include the alert list too (#233).
      const to = await subscriptionRecipients(env, ["opportunity", "award"]);
      const result = await sendAlertEmail(env, { to, subject: `🗓️ Content calendar: ${due.length} post${due.length === 1 ? "" : "s"} due soon`, text, from: senderFor(env, "cleo") });
      return result.sent;
    });

    return { dueCount: due.length, alerted };
  },
});
