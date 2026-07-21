import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { samGovOpportunitySearch } from "./tools";

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const inputSchema = z.object({
  keywords: z
    .string()
    .optional()
    .describe("Tech or domain keywords (e.g. 'database management postgresql cloud')"),
  naicsCodes: z
    .array(z.string())
    .default(["541512", "541511", "541519", "541330"])
    .describe("NAICS codes relevant to Lumiture. Defaults to IT/engineering codes"),
  agencies: z
    .array(z.string())
    .optional()
    .describe("Agencies to target (e.g. ['Department of Defense', 'DHS'])"),
  postedWithinDays: z.number().int().min(1).max(90).default(30),
  minScore: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(6)
    .describe("Minimum Beady fit score to include in shortlist"),
  limit: z.number().int().min(1).max(50).default(25),
});

const scoredOpportunitySchema = z.object({
  noticeId: z.string(),
  solicitationNumber: z.string().nullable(),
  title: z.string(),
  agency: z.string().nullable(),
  naicsCode: z.string().nullable(),
  setAside: z.string().nullable(),
  responseDeadline: z.string().nullable(),
  postedDate: z.string().nullable(),
  sourceUrl: z.string(),
  fitScore: z.number().int().min(1).max(10).describe("Beady's 1-10 fit score for Lumiture"),
  fitReason: z.string().describe("Why this opportunity fits, in 1-2 sentences"),
  redFlags: z.string().nullable().describe("Any concerns (clearance req, incumbent, etc.)"),
  recommendation: z.enum(["pursue", "monitor", "pass"]),
});

export const outputSchema = z.object({
  totalFound: z.number(),
  shortlistCount: z.number(),
  opportunities: z.array(scoredOpportunitySchema),
});

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "beady/opportunity-search",
  version: 1,
  description:
    "Search SAM.gov for open solicitations, score each against Lumiture's capabilities, and return a prioritised shortlist",
  cron: "0 8 * * 1", // Every Monday at 08:00 UTC
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input) {
    // Step 1: Search SAM.gov
    const searchResults = await step(ctx, "sam-gov-search", () =>
      samGovOpportunitySearch(ctx, {
        keywords: input.keywords,
        naicsCodes: input.naicsCodes,
        agencies: input.agencies,
        postedWithinDays: input.postedWithinDays,
        limit: input.limit,
        activeOnly: true,
      }),
    );

    if (searchResults.opportunities.length === 0) {
      return { totalFound: 0, shortlistCount: 0, opportunities: [] };
    }

    // Step 2: Score each opportunity against Lumiture's profile
    const scored = await llm_extract(ctx, {
      name: "score-opportunities",
      prompt: `
You are Beady, Lumiture's BD AI. Score each government contracting opportunity below
against Lumiture's capabilities and go/no-go criteria.

Lumiture profile:
- Core services: database management (PostgreSQL, Oracle, SQL Server, cloud DBs),
  data engineering, AI/ML integration, cloud infrastructure (AWS/Azure/GCP)
- Contract vehicle: primarily NAICS 541512, 541511, 541519
- Size: small business, US-based, cleared staff available
- Sweet spot: data modernisation, migration, managed database services for federal agencies
- Avoid: construction, physical security, very large primes where we'd be a sub with no visibility

Scoring rules (1-10):
- 8-10: direct match to our services, realistic award size, agency we can serve
- 6-7: partial match, worth monitoring or pursuing with a partner
- 4-5: stretch, only if pipeline is thin
- 1-3: clearly out of scope or too risky

Set recommendation to:
  "pursue"  → score ≥ 7 and no blocking red flags
  "monitor" → score 5-6 or score ≥ 7 with a red flag
  "pass"    → score ≤ 4 or a blocking red flag (e.g. requires large-business prime)

Only include opportunities with score ≥ ${input.minScore} in the final list.
      `.trim(),
      input: {
        opportunities: searchResults.opportunities.map((o) => ({
          noticeId: o.noticeId,
          solicitationNumber: o.solicitationNumber,
          title: o.title,
          agency: o.agency,
          naicsCode: o.naicsCode,
          setAside: o.setAside,
          responseDeadline: o.responseDeadline,
          description: o.description,
        })),
      },
      schema: z.object({
        scored: z.array(
          z.object({
            noticeId: z.string(),
            fitScore: z.number().int().min(1).max(10),
            fitReason: z.string(),
            redFlags: z.string().nullable(),
            recommendation: z.enum(["pursue", "monitor", "pass"]),
          }),
        ),
      }),
    });

    // Merge scores back into opportunity records
    const scoreMap = new Map(scored.scored.map((s) => [s.noticeId, s]));

    const shortlisted = searchResults.opportunities
      .map((opp) => {
        const score = scoreMap.get(opp.noticeId);
        if (!score || score.fitScore < input.minScore) return null;
        return {
          noticeId: opp.noticeId,
          solicitationNumber: opp.solicitationNumber,
          title: opp.title,
          agency: opp.agency,
          naicsCode: opp.naicsCode,
          setAside: opp.setAside,
          responseDeadline: opp.responseDeadline,
          postedDate: opp.postedDate,
          sourceUrl: opp.sourceUrl,
          fitScore: score.fitScore,
          fitReason: score.fitReason,
          redFlags: score.redFlags,
          recommendation: score.recommendation,
        };
      })
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .sort((a, b) => b.fitScore - a.fitScore);

    // Step 3: Upsert shortlisted opportunities into Supabase
    if (shortlisted.length > 0) {
      await step(ctx, "upsert-opportunities", async () => {
        const scoredAt = new Date().toISOString();
        const rows = shortlisted.map((o) => ({
          sam_notice_id: o.noticeId,
          solicitation_number: o.solicitationNumber,
          title: o.title,
          agency: o.agency,
          naics_code: o.naicsCode,
          set_aside: o.setAside,
          response_deadline: o.responseDeadline,
          posted_date: o.postedDate,
          source: "sam_gov",
          source_url: o.sourceUrl,
          status: "open",
          // Beady scoring columns (added in migration 0006)
          fit_score: o.fitScore,
          fit_reason: o.fitReason,
          red_flags: o.redFlags,
          recommendation: o.recommendation,
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
          throw new Error(`Supabase upsert opportunities → ${res.status}: ${text}`);
        }
      });
    }

    return {
      totalFound: searchResults.totalRecords,
      shortlistCount: shortlisted.length,
      opportunities: shortlisted,
    };
  },
});
