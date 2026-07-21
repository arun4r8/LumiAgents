import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import type { Env } from "@/runtime";
import { draftContentPost } from "../../../integrations/anthropic/content";

// Draft a LinkedIn eminence post for one content-calendar row, grounded in the company
// profile. Writes the draft back to the row and advances status to 'ready'. A human
// still approves/posts; this never publishes.

export const inputSchema = z.object({
  calendarId: z.string().uuid().describe("content_calendar.id of the entry to draft a post for."),
});

export const outputSchema = z.object({
  calendarId: z.string().uuid(),
  topic: z.string(),
  status: z.string(),
});

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function sbSelect<T = Record<string, unknown>>(env: Env, path: string): Promise<T[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`Supabase select ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

export default defineOrchestration({
  name: "cleo/content-draft",
  version: 1,
  triggerMode: "agent",
  description:
    "Draft a LinkedIn eminence post (copy + asset brief) for a content-calendar row, grounded in the company profile. Writes the draft back and sets status='ready'.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },
  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const env = ctx.env;

    const entry = await step(ctx, "load-entry", async () => {
      const rows = await sbSelect(env, `content_calendar?id=eq.${encodeURIComponent(input.calendarId)}&select=*&limit=1`);
      const e = rows[0];
      if (!e) throw new Error(`No content_calendar entry for id ${input.calendarId}`);
      return e;
    });

    const companyProfile = await step(ctx, "load-profile", async () => {
      const companies = await sbSelect<{ profile: unknown }>(env, "company_profiles?select=*&limit=1");
      const c = companies[0];
      return (c?.profile ?? c ?? {}) as unknown;
    });

    const draftMarkdown = await step(ctx, "draft-post", async () =>
      draftContentPost(env, { entry, companyProfile }, ctx.model),
    );

    await step(ctx, "store-draft", async () => {
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/content_calendar?id=eq.${encodeURIComponent(input.calendarId)}`,
        {
          method: "PATCH",
          headers: sbHeaders(env, { Prefer: "return=minimal" }),
          body: JSON.stringify({
            draft_markdown: draftMarkdown,
            status: "ready",
            model: ctx.model ?? "claude-sonnet-4-6",
            updated_at: new Date().toISOString(),
          }),
        },
      );
      if (!res.ok) throw new Error(`Supabase update content_calendar → ${res.status}: ${await res.text()}`);
    });

    return {
      calendarId: input.calendarId,
      topic: (entry.topic as string | null) ?? "Untitled",
      status: "ready",
    };
  },
});
