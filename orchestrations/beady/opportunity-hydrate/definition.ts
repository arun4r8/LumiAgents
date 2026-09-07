import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";
import { fetchNoticeDescription } from "../../../integrations/sam-gov/attachments";
import { recommendationFor, SCORE_MAX_TOKENS, SCORE_TIMEOUT_MS } from "../opportunity-sweep/definition";

/**
 * Fetch the notice body the sweep cannot afford, then re-score on it.
 *
 * SAM v2's `description` is a link, not text (#219), so every fit_score in
 * `opportunities` was computed from a title, a NAICS code and a set-aside. Fetching
 * a body costs one subrequest per notice against a Cloudflare ceiling of 50 per
 * invocation, and a 161-notice sweep cannot do that inline -- that fan-out is what
 * killed five sweeps in a day.
 *
 * So it happens here instead, in its own invocation with its own budget. The
 * division of labour is the point: the sweep decides WHICH notices are worth
 * reading, cheaply and on titles; this reads them properly and revises the score.
 *
 * It processes the shortlist only. A notice the sweep already rejected on its title
 * is not worth a subrequest, and the shortlist is the set anyone will actually look
 * at.
 */

export const inputSchema = z.object({
  batchSize: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(8)
    .describe("Notices to hydrate per run. Each costs 3 subrequests -- fetch the body, store it, write the new score -- against a 50-per-invocation Worker ceiling shared with this run's overhead."),
  minScore: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe("Only hydrate opportunities at or above this score: the sweep already rejected the rest on their titles."),
});

export const outputSchema = z.object({
  candidates: z.number().describe("Rows still lacking notice text at the start of the run."),
  hydrated: z.number().describe("Rows that got text."),
  empty: z.number().describe("Rows SAM had no body for. Marked as attempted so they are not retried for ever."),
  rescored: z.number(),
  changed: z.array(
    z.object({ samNoticeId: z.string(), title: z.string(), from: z.number(), to: z.number() }),
  ).describe("Opportunities whose score moved once the model could read the notice."),
});

interface Candidate {
  id: string;
  sam_notice_id: string;
  title: string;
  posted_date: string | null;
  fit_score: number | null;
}

const rescoreSchema = z.object({
  scored: z.array(
    z.object({
      samNoticeId: z.string(),
      fitScore: z.number().int().min(1).max(10),
      fitReason: z.string().max(200),
      redFlags: z.string().max(200).nullable(),
    }),
  ),
});

export default defineOrchestration({
  name: "beady/opportunity-hydrate",
  version: 1,
  description:
    "Fetch the SAM notice body for shortlisted opportunities and re-score them on it. The sweep scores titles because fetching bodies does not fit its subrequest budget; this closes that gap in its own invocation.",
  // 20 minutes after the sweep, so it works on what the sweep just stored.
  cron: "20 8 * * *",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const candidates = await step(ctx, "find-unhydrated", async () => {
      const params = new URLSearchParams({
        select: "id,sam_notice_id,title,posted_date,fit_score",
        source: "eq.sam_gov",
        notice_text_fetched_at: "is.null",
        fit_score: `gte.${input.minScore}`,
        order: "fit_score.desc,posted_date.desc",
        limit: String(input.batchSize),
      });
      const res = await ctx.fetch(`${ctx.env.SUPABASE_URL}/rest/v1/opportunities?${params}`, {
        headers: sbHeaders(ctx.env),
      });
      if (!res.ok) throw new Error(`hydrate candidates → ${res.status}: ${await res.text()}`);
      return (await res.json()) as Candidate[];
    });

    if (candidates.length === 0) {
      return { candidates: 0, hydrated: 0, empty: 0, rescored: 0, changed: [] };
    }

    // One fetch per notice, then one write per notice. Both bounded by batchSize,
    // which is bounded so the total stays inside the Worker ceiling.
    const fetched = await step(ctx, "fetch-notice-text", async () => {
      const out: { id: string; samNoticeId: string; title: string; text: string; note: string }[] = [];
      for (const c of candidates) {
        // One request per notice, not the 2-6 the attachment-aware fetcher costs.
        // Scoring needs the body; it does not need the PDFs.
        const r = await fetchNoticeDescription(ctx.env, c.sam_notice_id, 20_000);
        out.push({ id: c.id, samNoticeId: c.sam_notice_id, title: c.title, text: r.text, note: r.note });
      }
      return out;
    });

    await step(ctx, "store-notice-text", async () => {
      const now = new Date().toISOString();
      // One PATCH per row: each carries its own text. batchSize caps this.
      for (const f of fetched) {
        const res = await ctx.fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/opportunities?id=eq.${encodeURIComponent(f.id)}`,
          {
            method: "PATCH",
            headers: sbHeaders(ctx.env, { extra: { Prefer: "return=minimal" } }),
            // fetched_at is set even when the text is empty, so a notice SAM has no
            // body for is not retried on every run for ever.
            body: JSON.stringify({ notice_text: f.text || null, notice_text_fetched_at: now }),
          },
        );
        if (!res.ok) console.warn(`[hydrate] store ${f.samNoticeId} → ${res.status}: ${await res.text()}`);
      }
    });

    const withText = fetched.filter((f) => f.text.length > 0);
    if (withText.length === 0) {
      return { candidates: candidates.length, hydrated: 0, empty: fetched.length, rescored: 0, changed: [] };
    }

    const rescored = await llm_extract(ctx, {
      name: "rescore-on-notice-text",
      prompt: `
You are Beady, Lumiture's BD AI. Each opportunity below now includes the ACTUAL
NOTICE TEXT from SAM.gov. Score fit against Lumiture's profile using that text, not
the title alone.

Lumiture profile:
- Core services: database management (PostgreSQL, Oracle, SQL Server, cloud DBs), data engineering,
  AI/ML integration, cloud infrastructure (AWS/Azure/GCP), analytics, software development
- Business type: small business, US-based, cleared staff available
- Sweet spot: data modernisation, AI/ML tooling, cloud migration, decision support systems,
  managed database services for federal agencies
- Lower fit: construction, physical hardware, manufacturing, chemical/biological R&D

Scoring (1-10):
- 8-10: strong direct match
- 6-7: partial match or promising with a partner
- 4-5: stretch, surface for leadership to decide
- 1-3: out of scope

These were previously scored on the title alone, so DISAGREEING with the earlier
score is the expected and useful outcome. Score what the notice actually says.

Return one entry per opportunity. Keep fitReason to one sentence of at most 25
words and redFlags to a short clause or null.
      `.trim(),
      input: {
        opportunities: withText.map((f) => ({
          samNoticeId: f.samNoticeId,
          title: f.title,
          noticeText: f.text.slice(0, 12_000),
        })),
      },
      schema: rescoreSchema,
      maxTokens: SCORE_MAX_TOKENS,
      timeoutMs: SCORE_TIMEOUT_MS,
    });

    const before = new Map(candidates.map((c) => [c.sam_notice_id, c.fit_score ?? 0]));
    const changed: z.infer<typeof outputSchema>["changed"] = [];

    await step(ctx, "apply-rescore", async () => {
      const now = new Date().toISOString();
      for (const s of rescored.scored) {
        const res = await ctx.fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/opportunities?sam_notice_id=eq.${encodeURIComponent(s.samNoticeId)}`,
          {
            method: "PATCH",
            headers: sbHeaders(ctx.env, { extra: { Prefer: "return=minimal" } }),
            body: JSON.stringify({
              fit_score: s.fitScore,
              fit_reason: s.fitReason,
              red_flags: s.redFlags,
              recommendation: recommendationFor(s.fitScore),
              last_scored_at: now,
            }),
          },
        );
        if (!res.ok) console.warn(`[hydrate] rescore ${s.samNoticeId} → ${res.status}: ${await res.text()}`);
      }
    });

    for (const s of rescored.scored) {
      const from = before.get(s.samNoticeId);
      if (from !== undefined && from !== s.fitScore) {
        changed.push({
          samNoticeId: s.samNoticeId,
          title: withText.find((f) => f.samNoticeId === s.samNoticeId)?.title ?? "",
          from,
          to: s.fitScore,
        });
      }
    }

    return {
      candidates: candidates.length,
      hydrated: withText.length,
      empty: fetched.length - withText.length,
      rescored: rescored.scored.length,
      changed,
    };
  },
});
