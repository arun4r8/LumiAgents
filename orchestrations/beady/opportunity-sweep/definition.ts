import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { samGovOpportunitySearch, sbirTopicSearch } from "./tools";

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const inputSchema = z.object({
  keywords: z
    .string()
    .optional()
    .describe("Keywords applied to both SAM.gov and SBIR searches"),
  naicsCodes: z
    .array(z.string())
    .default(["541512", "541511", "541519", "541330"])
    .describe("NAICS codes for SAM.gov filter (SBIR topics don't use NAICS)"),
  agencies: z
    .array(z.string())
    .optional()
    .describe("Agency name filter for SAM.gov (e.g. ['Department of Defense'])"),
  sbirComponents: z
    .array(z.string())
    .optional()
    .describe("DoD branch filter for SBIR (e.g. ['ARMY', 'USAF']). Omit for all."),
  postedWithinDays: z.number().int().min(1).max(90).default(30),
  minScore: z.number().int().min(1).max(10).default(5),
  samLimit: z.number().int().min(1).max(50).default(25),
  sbirLimit: z.number().int().min(1).max(200).default(50),
});

const scoredOpportunitySchema = z.object({
  externalId: z.string().describe("sam_notice_id value used for DB upsert"),
  source: z.enum(["sam_gov", "sbir"]),
  title: z.string(),
  agency: z.string().nullable(),
  setAside: z.string().nullable(),
  responseDeadline: z.string().nullable(),
  sourceUrl: z.string(),
  fitScore: z.number().int().min(1).max(10),
  fitReason: z.string(),
  redFlags: z.string().nullable(),
  recommendation: z.enum(["pursue", "monitor", "pass"]),
});

export const outputSchema = z.object({
  samFound: z.number(),
  sbirFound: z.number(),
  shortlistCount: z.number(),
  opportunities: z.array(scoredOpportunitySchema),
});

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "beady/opportunity-sweep",
  version: 1,
  description:
    "Parallel sweep of SAM.gov + DoD SBIR/STTR topics. Scores all results together in one LLM pass and upserts the shortlist into opportunities.",
  // Replace the two individual Monday crons — this one sweep covers both sources
  cron: "0 8 * * 1",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input) {
    // Step 1: Fetch both sources in parallel inside a single step
    const { samResults, sbirResults } = await step(ctx, "fetch-both-sources", async () => {
      const [samResults, sbirResults] = await Promise.all([
        samGovOpportunitySearch(ctx, {
          keywords: input.keywords,
          naicsCodes: input.naicsCodes,
          agencies: input.agencies,
          postedWithinDays: input.postedWithinDays,
          limit: input.samLimit,
          activeOnly: true,
        }),
        sbirTopicSearch(ctx, {
          keyword: input.keywords,
          component: input.sbirComponents,
          topicStatus: "Open",
          limit: input.sbirLimit,
        }),
      ]);
      return { samResults, sbirResults };
    });

    const totalFound = samResults.opportunities.length + sbirResults.topics.length;
    if (totalFound === 0) {
      return { samFound: 0, sbirFound: 0, shortlistCount: 0, opportunities: [] };
    }

    // Step 2: Score all results together in one LLM call
    const scored = await llm_extract(ctx, {
      name: "score-all-opportunities",
      prompt: `
You are Beady, Lumiture's BD AI. Score each opportunity below against Lumiture's profile.
Opportunities come from two sources: SAM.gov (traditional contracts) and DoD SBIR/STTR (R&D
solicitations). Apply the same scoring logic to both — SBIR topics are R&D-focused so expect
lower technical fit scores on average, but surface them anyway for leadership review.

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

recommendation:
  "pursue"  → score ≥ 7
  "monitor" → score 5-6
  "pass"    → score ≤ 4

Only include items with fitScore ≥ ${input.minScore} in the output.
      `.trim(),
      input: {
        opportunities: [
          ...samResults.opportunities.map((o) => ({
            id: `sam_${o.noticeId}`,
            source: "SAM.gov",
            title: o.title,
            agency: o.agency,
            naicsCode: o.naicsCode,
            setAside: o.setAside,
            deadline: o.responseDeadline,
            description: o.description,
          })),
          ...sbirResults.topics.map((t) => ({
            id: `sbir_${t.topicNumber}`,
            source: `SBIR/STTR (${t.program} ${t.phase})`,
            title: t.title,
            agency: t.component,
            naicsCode: null,
            setAside: `${t.program} ${t.phase}`,
            deadline: t.closeDate,
            description: t.abstract,
          })),
        ],
      },
      schema: z.object({
        scored: z.array(
          z.object({
            id: z.string(),
            fitScore: z.number().int().min(1).max(10),
            fitReason: z.string(),
            redFlags: z.string().nullable(),
            recommendation: z.enum(["pursue", "monitor", "pass"]),
          }),
        ),
      }),
    });

    const scoreMap = new Map(scored.scored.map((s) => [s.id, s]));

    // Build the shortlist, resolving back to source-specific fields
    type ScoredOpportunity = z.infer<typeof scoredOpportunitySchema>;
    const shortlisted: ScoredOpportunity[] = [];

    for (const opp of samResults.opportunities) {
      const score = scoreMap.get(`sam_${opp.noticeId}`);
      if (!score || score.fitScore < input.minScore) continue;
      shortlisted.push({
        externalId: opp.noticeId,
        source: "sam_gov",
        title: opp.title,
        agency: opp.agency,
        setAside: opp.setAside,
        responseDeadline: opp.responseDeadline,
        sourceUrl: opp.sourceUrl,
        ...score,
      });
    }

    for (const topic of sbirResults.topics) {
      const score = scoreMap.get(`sbir_${topic.topicNumber}`);
      if (!score || score.fitScore < input.minScore) continue;
      shortlisted.push({
        externalId: `sbir_${topic.topicNumber}`,
        source: "sbir",
        title: `[${topic.program} ${topic.phase}] ${topic.title}`,
        agency: topic.component,
        setAside: `${topic.program} ${topic.phase}`,
        responseDeadline: topic.closeDate,
        sourceUrl: topic.sourceUrl,
        ...score,
      });
    }

    shortlisted.sort((a, b) => b.fitScore - a.fitScore);

    // Step 3: Upsert shortlist into opportunities
    if (shortlisted.length > 0) {
      await step(ctx, "upsert-opportunities", async () => {
        const scoredAt = new Date().toISOString();

        // Map back to full SAM.gov / SBIR records for extra fields
        const samMap = new Map(samResults.opportunities.map((o) => [o.noticeId, o]));
        const sbirMap = new Map(sbirResults.topics.map((t) => [`sbir_${t.topicNumber}`, t]));

        const rows = shortlisted.map((o) => {
          if (o.source === "sam_gov") {
            const sam = samMap.get(o.externalId)!;
            return {
              sam_notice_id:      o.externalId,
              solicitation_number: sam.solicitationNumber,
              title:              o.title,
              agency:             o.agency,
              naics_code:         sam.naicsCode,
              set_aside:          o.setAside,
              response_deadline:  o.responseDeadline,
              posted_date:        sam.postedDate,
              source:             "sam_gov",
              source_url:         o.sourceUrl,
              status:             "open",
              fit_score:          o.fitScore,
              fit_reason:         o.fitReason,
              red_flags:          o.redFlags,
              recommendation:     o.recommendation,
              last_scored_at:     scoredAt,
            };
          } else {
            const sbir = sbirMap.get(o.externalId)!;
            return {
              sam_notice_id:      o.externalId,
              solicitation_number: sbir.solicitationTitle,
              title:              o.title,
              agency:             o.agency,
              naics_code:         null,
              set_aside:          o.setAside,
              response_deadline:  o.responseDeadline,
              posted_date:        sbir.openDate,
              source:             "sbir",
              source_url:         o.sourceUrl,
              status:             "open",
              fit_score:          o.fitScore,
              fit_reason:         o.fitReason,
              red_flags:          o.redFlags,
              recommendation:     o.recommendation,
              last_scored_at:     scoredAt,
            };
          }
        });

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
          throw new Error(`Supabase upsert → ${res.status}: ${text}`);
        }
      });
    }

    return {
      samFound: samResults.totalRecords,
      sbirFound: sbirResults.totalElements,
      shortlistCount: shortlisted.length,
      opportunities: shortlisted,
    };
  },
});
