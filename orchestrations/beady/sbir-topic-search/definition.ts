import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { sbirTopicSearch } from "./tools";

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const inputSchema = z.object({
  keyword: z
    .string()
    .optional()
    .describe("Tech/domain keywords to filter topics (e.g. 'data management cloud AI')"),
  component: z
    .array(z.string())
    .optional()
    .describe("DoD branch filter, e.g. ['ARMY', 'USAF']. Omit to search all branches."),
  topicStatus: z
    .enum(["Open", "Closed", "Pre-Release"])
    .default("Open")
    .describe("Topic lifecycle status"),
  minScore: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(4)
    .describe(
      "Minimum Beady fit score to include. Default is low (4) because SBIR topics skew R&D; " +
      "run the full assessment to get a proper go/no-go after sourcing.",
    ),
  limit: z.number().int().min(1).max(200).default(50),
});

const scoredTopicSchema = z.object({
  topicId: z.number(),
  topicNumber: z.string(),
  title: z.string(),
  program: z.string(),
  phase: z.string(),
  component: z.string().nullable(),
  solicitationTitle: z.string().nullable(),
  openDate: z.string().nullable(),
  closeDate: z.string().nullable(),
  sourceUrl: z.string(),
  fitScore: z.number().int().min(1).max(10),
  fitReason: z.string(),
  redFlags: z.string().nullable(),
  recommendation: z.enum(["pursue", "monitor", "pass"]),
});

export const outputSchema = z.object({
  totalFound: z.number(),
  shortlistCount: z.number(),
  topics: z.array(scoredTopicSchema),
});

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "beady/sbir-topic-search",
  version: 1,
  description:
    "Search DoD SBIR/STTR topics from dodsbirsttr.mil, score them against Lumiture's profile, " +
    "and upsert shortlisted topics into the opportunities table for downstream govcon-assessment runs",
  // Run every Monday at 09:00 UTC (1h after the SAM.gov sweep)
  cron: "0 9 * * 1",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input) {
    // Step 1: Fetch topics from dodsbirsttr.mil
    const searchResults = await step(ctx, "sbir-topic-fetch", () =>
      sbirTopicSearch(ctx, {
        keyword: input.keyword,
        component: input.component,
        topicStatus: input.topicStatus,
        limit: input.limit,
      }),
    );

    if (searchResults.topics.length === 0) {
      return { totalFound: 0, shortlistCount: 0, topics: [] };
    }

    // Step 2: Score each topic against Lumiture's profile
    const scored = await llm_extract(ctx, {
      name: "score-sbir-topics",
      prompt: `
You are Beady, Lumiture's BD AI. Evaluate each DoD SBIR/STTR topic below against Lumiture's
capabilities. SBIR/STTR topics are government-funded R&D solicitations. They are deliberately
broader in scope than traditional contracts, covering Phase I feasibility (~$250K) and Phase II
prototype (~$1.5M). Score generously: we're sourcing candidates for the full govcon-assessment
pipeline, not making final bid decisions here.

Lumiture profile:
- Core services: database management (PostgreSQL, Oracle, SQL Server, cloud DBs), data engineering,
  AI/ML integration, cloud infrastructure (AWS/Azure/GCP), analytics, software development
- Business type: small business, US-based, cleared staff available for sensitive work
- SBIR sweet spot: data modernisation, AI/ML tooling, software-defined systems, cloud migration,
  decision support systems, logistics software
- Lower fit: pure hardware, manufacturing, chemical/biological R&D, construction

Scoring rules (1-10):
- 8-10: strong software/data/AI angle that Lumiture can credibly address
- 6-7: partial match, software component exists but hardware-heavy
- 4-5: stretch or niche R&D, but worth surfacing for leadership to decide
- 1-3: clearly hardware, manufacturing, or domain we cannot serve

Set recommendation to:
  "pursue"  → score ≥ 7
  "monitor" → score 5-6
  "pass"    → score ≤ 4

Only include topics with fitScore ≥ ${input.minScore} in the output.
      `.trim(),
      input: {
        topics: searchResults.topics.map((t) => ({
          topicId: t.topicId,
          topicNumber: t.topicNumber,
          title: t.title,
          program: t.program,
          phase: t.phase,
          component: t.component,
          abstract: t.abstract,
        })),
      },
      schema: z.object({
        scored: z.array(
          z.object({
            topicId: z.number(),
            fitScore: z.number().int().min(1).max(10),
            fitReason: z.string(),
            redFlags: z.string().nullable(),
            recommendation: z.enum(["pursue", "monitor", "pass"]),
          }),
        ),
      }),
    });

    const scoreMap = new Map(scored.scored.map((s) => [s.topicId, s]));

    const shortlisted = searchResults.topics
      .map((topic) => {
        const score = scoreMap.get(topic.topicId);
        if (!score || score.fitScore < input.minScore) return null;
        return { ...topic, ...score };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .sort((a, b) => b.fitScore - a.fitScore);

    // Step 3: Upsert shortlisted topics into opportunities table
    // sam_notice_id is used as the generic external-ID column; prefix with "sbir_" to
    // namespace SBIR topic numbers away from SAM.gov notice IDs.
    if (shortlisted.length > 0) {
      await step(ctx, "upsert-sbir-opportunities", async () => {
        const scoredAt = new Date().toISOString();
        const rows = shortlisted.map((t) => ({
          sam_notice_id: `sbir_${t.topicNumber}`,
          solicitation_number: t.solicitationTitle,
          title: `[${t.program} ${t.phase}] ${t.title}`,
          agency: t.component,
          naics_code: null,
          set_aside: `${t.program} ${t.phase}`,
          response_deadline: t.closeDate,
          posted_date: t.openDate,
          source: "sbir",
          source_url: t.sourceUrl,
          status: "open",
          fit_score: t.fitScore,
          fit_reason: t.fitReason,
          red_flags: t.redFlags,
          recommendation: t.recommendation,
          last_scored_at: scoredAt,
        }));

        const res = await ctx.fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/opportunities?on_conflict=sam_notice_id`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
              Prefer: "resolution=merge-duplicates",
            },
            body: JSON.stringify(rows),
          },
        );

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Supabase upsert SBIR opportunities → ${res.status}: ${text}`);
        }
      });
    }

    return {
      totalFound: searchResults.totalElements,
      shortlistCount: shortlisted.length,
      topics: shortlisted,
    };
  },
});
