import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { tavilySearch } from "./tools";

// FNV-1a, the same approach as the opportunity-sweep content fingerprinting.
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function awardHash(url: string, title: string): string {
  return fnv1a(`${url}::${title}`);
}

// ─── Search query sets ────────────────────────────────────────────────────────

const INDUSTRY_QUERIES = [
  "govcon award nominations 2026 open small business apply",
  "government contracting awards 2026 applications open",
  "federal IT technology company award nominations 2026",
  "Washington Technology Fast 50 2026 nominations",
  "FCW Federal 100 award 2026 nominations open",
  "Wash100 award 2026 nominations",
];

const GOVERNMENT_QUERIES = [
  "SBA small business of the year award nominations 2026",
  "SBIR excellence award 2026 nominations open",
  "federal agency small business innovation award 2026 nominations",
];

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const inputSchema = z.object({
  includeIndustry:  z.boolean().default(true),
  includeGovernment: z.boolean().default(true),
  minScore: z.number().int().min(1).max(10).default(5),
});

const scoredAwardSchema = z.object({
  awardId:             z.string(),
  title:               z.string(),
  sponsor:             z.string().nullable(),
  category:            z.string().nullable(),
  awardType:           z.enum(["industry", "government"]),
  applicationDeadline: z.string().nullable(),
  nominationDeadline:  z.string().nullable(),
  sourceUrl:           z.string(),
  fitScore:            z.number().int().min(1).max(10),
  fitReason:           z.string(),
  prestige:            z.enum(["high", "medium", "low"]),
  effort:              z.enum(["low", "medium", "high"]),
  recommendation:      z.enum(["apply", "consider", "skip"]),
});

export const outputSchema = z.object({
  searchesRun:    z.number(),
  rawResults:     z.number(),
  shortlistCount: z.number(),
  awards:         z.array(scoredAwardSchema),
});

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "cleo/award-sweep",
  version: 1,
  description:
    "Weekly Tavily sweep for industry recognition awards and government small business award programs. Scores each on fit, prestige, and application effort, then upserts into the awards table.",
  cron: "0 9 * * 1",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input) {
    // Step 1: Run Tavily searches and deduplicate by URL
    const { rawItems, searchesRun } = await step(ctx, "fetch-award-candidates", async () => {
      type RawItem = { url: string; title: string; content: string; type: "industry" | "government" };

      const queries: Array<{ query: string; type: "industry" | "government" }> = [
        ...(input.includeIndustry
          ? INDUSTRY_QUERIES.map((q) => ({ query: q, type: "industry" as const }))
          : []),
        ...(input.includeGovernment
          ? GOVERNMENT_QUERIES.map((q) => ({ query: q, type: "government" as const }))
          : []),
      ];

      const all: RawItem[] = [];
      let ran = 0;

      for (const { query, type } of queries) {
        // tavilySearch handles budget internally and degrades gracefully on missing key
        const hits = await tavilySearch(ctx.env, { query, maxResults: 5 });
        if (hits.length > 0) ran++;
        for (const h of hits) {
          if (h.url) all.push({ ...h, type });
        }
      }

      // Deduplicate by URL, keeping the first occurrence
      const seen = new Set<string>();
      const unique = all.filter((r) => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });

      return { rawItems: unique, searchesRun: ran };
    });

    if (rawItems.length === 0) {
      return { searchesRun, rawResults: 0, shortlistCount: 0, awards: [] };
    }

    // Step 2: Filter out items whose content hash hasn't changed since last score
    const { newItems } = await step(ctx, "check-dedup-ledger", async () => {
      const ledger = new Map<string, string>(); // award_id → content_hash
      try {
        const res = await ctx.fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/award_scored?select=award_id,content_hash`,
          {
            headers: {
              apikey:          ctx.env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization:   `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
              "Accept-Profile": "orchestration",
            },
          },
        );
        if (res.ok) {
          for (const row of (await res.json()) as Array<{ award_id: string; content_hash: string }>) {
            ledger.set(row.award_id, row.content_hash);
          }
        }
      } catch (e) {
        console.warn("[award-sweep] ledger lookup failed, scoring all:", e);
      }

      const newItems = rawItems.filter((item) => {
        const id   = fnv1a(item.url);
        const hash = awardHash(item.url, item.title);
        return !ledger.has(id) || ledger.get(id) !== hash;
      });

      return { newItems };
    });

    // Step 3: LLM score all new items in one pass
    const scored = await llm_extract(ctx, {
      name: "score-awards",
      prompt: `
You are Beady, Lumiture's BD AI. Evaluate each award opportunity for Lumiture.

Lumiture profile:
- Database management startup: PostgreSQL, Oracle, SQL Server, cloud DBs, data engineering
- AI/ML integration and agentic infrastructure (building autonomous internal agents)
- Small business, US-based, DC-area, federal government focus
- Looking to build brand recognition through awards for eminence and business development

Fit score (1-10):
- 8-10: strong match, Lumiture clearly eligible, high value to apply
- 6-7: good fit, eligible and worth the effort
- 4-5: possible, stretch eligibility or niche value
- 1-3: not applicable, wrong industry, size, or geography

recommendation:
  "apply"    → fit ≥ 7
  "consider" → fit 5-6
  "skip"     → fit ≤ 4

prestige: "high" = nationally recognized (Inc 5000, Wash100, FCW Federal 100), "medium" = industry-known, "low" = local/minor
effort: "low" = short nomination form, "medium" = written application + references, "high" = extensive documentation

For each item extract: title, sponsor (who administers the award), category (the award program name or subcategory),
awardType ("industry" or "government"), applicationDeadline (extract from content if visible, else null),
nominationDeadline (null if not found), fitScore, fitReason (1-2 sentences), prestige, effort, recommendation.

Only return items scoring ≥ ${input.minScore}.
      `.trim(),
      input: {
        items: newItems.map((item, i) => ({
          id:         i,
          url:        item.url,
          title:      item.title,
          content:    item.content,
          searchType: item.type,
        })),
      },
      schema: z.object({
        awards: z.array(
          z.object({
            id:                  z.number(),
            title:               z.string(),
            sponsor:             z.string().nullable(),
            category:            z.string().nullable(),
            awardType:           z.enum(["industry", "government"]),
            applicationDeadline: z.string().nullable(),
            nominationDeadline:  z.string().nullable(),
            fitScore:            z.number().int().min(1).max(10),
            fitReason:           z.string(),
            prestige:            z.enum(["high", "medium", "low"]),
            effort:              z.enum(["low", "medium", "high"]),
            recommendation:      z.enum(["apply", "consider", "skip"]),
          }),
        ),
      }),
    });

    // Step 4: Upsert to awards table + record all scored items in ledger
    const shortlist: z.infer<typeof scoredAwardSchema>[] = [];

    for (const s of scored.awards) {
      const raw = newItems[s.id];
      if (!raw) continue;
      shortlist.push({
        awardId:             fnv1a(raw.url),
        title:               s.title,
        sponsor:             s.sponsor,
        category:            s.category,
        awardType:           s.awardType,
        applicationDeadline: s.applicationDeadline,
        nominationDeadline:  s.nominationDeadline,
        sourceUrl:           raw.url,
        fitScore:            s.fitScore,
        fitReason:           s.fitReason,
        prestige:            s.prestige,
        effort:              s.effort,
        recommendation:      s.recommendation,
      });
    }

    await step(ctx, "persist-results", async () => {
      const scoredAt = new Date().toISOString();

      if (shortlist.length > 0) {
        const rows = shortlist.map((a) => ({
          award_id:             a.awardId,
          title:                a.title,
          sponsor:              a.sponsor,
          category:             a.category,
          award_type:           a.awardType,
          application_deadline: a.applicationDeadline,
          nomination_deadline:  a.nominationDeadline,
          source_url:           a.sourceUrl,
          fit_score:            a.fitScore,
          fit_reason:           a.fitReason,
          prestige:             a.prestige,
          effort:               a.effort,
          recommendation:       a.recommendation,
          last_scored_at:       scoredAt,
        }));

        const res = await ctx.fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/awards?on_conflict=award_id`,
          {
            method: "POST",
            headers: {
              "Content-Type":  "application/json",
              apikey:          ctx.env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization:   `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
              Prefer:          "resolution=merge-duplicates,return=minimal",
            },
            body: JSON.stringify(rows),
          },
        );
        if (!res.ok) throw new Error(`awards upsert → ${res.status}: ${await res.text()}`);
      }

      // Record every scored item in the dedup ledger (pass and shortlist alike)
      const ledgerRows = newItems.map((item) => ({
        award_id:     fnv1a(item.url),
        content_hash: awardHash(item.url, item.title),
        scored_at:    scoredAt,
      }));

      if (ledgerRows.length > 0) {
        const lres = await ctx.fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/award_scored?on_conflict=award_id`,
          {
            method: "POST",
            headers: {
              "Content-Type":    "application/json",
              apikey:            ctx.env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization:     `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Profile": "orchestration",
              Prefer:            "resolution=merge-duplicates,return=minimal",
            },
            body: JSON.stringify(ledgerRows),
          },
        );
        if (!lres.ok) console.warn(`[award-sweep] ledger insert → ${lres.status}: ${await lres.text()}`);
      }
    });

    shortlist.sort((a, b) => b.fitScore - a.fitScore);

    return {
      searchesRun,
      rawResults: rawItems.length,
      shortlistCount: shortlist.length,
      awards: shortlist,
    };
  },
});
