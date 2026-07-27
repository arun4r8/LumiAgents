import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { tavilySearch } from "./tools";
import { sbHeaders } from "@/runtime/utils/supabase";
import { fnv1a } from "@/runtime/utils/hash";
import { loadContentHashLedger, contentChanged, upsertContentHashLedger } from "@/runtime/utils/scored-sweep";

function awardHash(url: string, title: string): string {
  return fnv1a(`${url}::${title}`);
}

// Normalize an award title into a stable key so the same award seen at
// different URLs collapses to one dedup key. Lowercases, strips ®/™,
// removes parenthetical segments and 4-digit years, replaces non-alphanumerics
// with spaces, then collapses and trims whitespace.
function normalizeAwardKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[®™]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\b\d{4}\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Search query sets ────────────────────────────────────────────────────────
// Year is computed at runtime (not hardcoded) so the queries stay current.
// Sources curated from the eminence lead's target-source list: FedScoop 50,
// ACT-IAC (incl. Igniting Innovation), Washington Business Journal (incl.
// fastest-growing companies), fastest-growing-small-business rankings, and the
// OnCon Icon Awards — kept alongside the strong existing GovCon programs.

function industryQueries(year: number): string[] {
  return [
    `FedScoop 50 awards ${year} nominations`,
    `ACT-IAC awards ${year} nominations`,
    `ACT-IAC Igniting Innovation awards ${year}`,
    `Washington Business Journal awards ${year} nominations`,
    `Washington Business Journal fastest growing companies ${year}`,
    `fastest growing small business award ${year} nominations govcon`,
    `OnCon Icon Awards ${year} nominations`,
    `Greater Washington government contractor awards ${year} nominations`,
    `Washington Technology Fast 50 ${year} nominations`,
    `Wash100 award ${year} nominations`,
    `FCW Federal 100 award ${year} nominations`,
  ];
}

function governmentQueries(year: number): string[] {
  return [
    `SBA small business award ${year} nominations`,
    `SBIR excellence award ${year} nominations`,
  ];
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const inputSchema = z.object({
  includeIndustry:  z.boolean().default(true),
  includeGovernment: z.boolean().default(true),
  minScore: z.number().int().min(1).max(10).default(5),
});

const setAsideEnum   = z.enum(["none", "8(a)", "SDVOSB", "WOSB", "HUBZone", "other"]);
const ownerEnum      = z.enum(["none", "veteran", "woman", "minority", "other"]);
const applicantEnum  = z.enum(["company", "individual", "federal_employee", "any"]);

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
  cycleStatus:         z.enum(["open", "closed", "hub", "unknown"]),
  // Eligibility REQUIREMENTS the award demands of an applicant (extracted, not judged).
  setAsideRequired:    setAsideEnum,
  ownerRequired:       ownerEnum,
  revenueCapUsd:       z.number().nullable(),
  applicantType:       applicantEnum,
  minYears:            z.number().nullable(),
  maxYears:            z.number().nullable(),
  // Generic, eligibility-agnostic recommendation for the ops radar (computed in code).
  recommendation:      z.enum(["apply", "consider", "skip"]),
});

// Generic global recommendation for the ops /awards radar — eligibility-agnostic
// (per-subscriber eligibility is matched later, in the award digest).
function computeRecommendation(
  cycleStatus: "open" | "closed" | "hub" | "unknown",
  fitScore: number,
): "apply" | "consider" | "skip" {
  if (cycleStatus === "closed") return "skip";
  if (fitScore >= 7) return "apply";
  if (fitScore >= 5) return "consider";
  return "skip";
}

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
    const today = new Date().toISOString().slice(0, 10);
    const year = new Date().getFullYear();

    // Step 1: Run Tavily searches and deduplicate by URL
    const { rawItems, searchesRun } = await step(ctx, "fetch-award-candidates", async () => {
      type RawItem = { url: string; title: string; content: string; type: "industry" | "government" };

      const queries: Array<{ query: string; type: "industry" | "government" }> = [
        ...(input.includeIndustry
          ? industryQueries(year).map((q) => ({ query: q, type: "industry" as const }))
          : []),
        ...(input.includeGovernment
          ? governmentQueries(year).map((q) => ({ query: q, type: "government" as const }))
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
      const ledger = await loadContentHashLedger(ctx, {
        table: "award_scored",
        keyColumn: "award_id",
        profile: "orchestration",
        warnLabel: "[award-sweep] ledger lookup failed, scoring all:",
      });

      const newItems = rawItems.filter((item) =>
        contentChanged(ledger, fnv1a(item.url), awardHash(item.url, item.title)),
      );

      return { newItems };
    });

    // Step 3: LLM score all new items in one pass
    const scored = await llm_extract(ctx, {
      name: "score-awards",
      prompt: `
You are Cleo, Lumiture's eminence/awards AI. For each award opportunity, extract its details, its eligibility REQUIREMENTS, and a general desirability read. Do NOT judge whether any specific company qualifies — eligibility is matched later, per subscriber. Today's date is ${today}.

Context: these awards are for small-business government contractors and federal IT / technology / data companies looking to build brand recognition (eminence) and support business development.

STEP 1 — Page type. Decide what each source page actually is:
- "open"    = a specific, currently-open nomination/application (has eligibility rules and ideally a deadline).
- "closed"  = a specific past cycle (deadline already passed, or an article about a prior year's awards).
- "hub"     = a topic/tag/aggregator/index/landing page with no specific cycle (e.g. a "/topic/..." page or an evergreen awards hub).
- "unknown" = cannot tell from the content.
Do NOT invent a deadline for hub or closed pages.

STEP 2 — Eligibility REQUIREMENTS (what the award demands of an applicant). Record the permissive value if the page does not restrict a dimension:
- setAsideRequired: certification/set-aside required to apply — one of ["none","8(a)","SDVOSB","WOSB","HUBZone","other"]. "none" = open to any small business.
- ownerRequired: ownership status required — one of ["none","veteran","woman","minority","other"].
- revenueCapUsd: maximum annual revenue to be eligible (integer USD), or null if no cap.
- applicantType: who may be nominated — one of ["company","individual","federal_employee","any"]. Use "federal_employee" for awards honoring government employees (not contractors); "individual" for personal/leadership honors.
- minYears / maxYears: company-age bounds the award specifies, else null.
Extract these from the eligibility/rules text; if unstated, use the permissive value ("none"/"any"/null).

STEP 3 — General desirability (relevance + reach, NOT company-specific eligibility):
- fitScore (1-10): how valuable this award is for a DC-area small-business GovCon / federal IT & data company's eminence and BD, assuming the applicant is eligible. 8-10 = flagship GovCon/federal-IT recognition; 4-6 = relevant but niche; 1-3 = off-target industry.
- prestige: "high" = nationally recognized (Inc 5000, Wash100, FCW/Federal 100), "medium" = industry-known, "low" = local/minor.
- effort: "low" = short nomination form, "medium" = written application + references, "high" = extensive documentation.

For each item extract: title, sponsor (who administers it), category (program name/subcategory), awardType ("industry"|"government"), applicationDeadline (from content, else null), nominationDeadline (else null), cycleStatus ("open"|"closed"|"hub"|"unknown"), setAsideRequired, ownerRequired, revenueCapUsd, applicantType, minYears, maxYears, fitScore, fitReason (1-2 sentences; name any eligibility caveat), prestige, effort.

Return an item ONLY if it is a real award program with fitScore >= ${input.minScore} AND cycleStatus is NOT "hub". Drop topic/aggregator/hub pages entirely.
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
            cycleStatus:         z.enum(["open", "closed", "hub", "unknown"]),
            setAsideRequired:    setAsideEnum,
            ownerRequired:       ownerEnum,
            revenueCapUsd:       z.number().nullable(),
            applicantType:       applicantEnum,
            minYears:            z.number().nullable(),
            maxYears:            z.number().nullable(),
            fitScore:            z.number().int().min(1).max(10),
            fitReason:           z.string(),
            prestige:            z.enum(["high", "medium", "low"]),
            effort:              z.enum(["low", "medium", "high"]),
          }),
        ),
      }),
    });

    // Step 4: Upsert to awards table + record all scored items in ledger
    const shortlist: z.infer<typeof scoredAwardSchema>[] = [];

    for (const s of scored.awards) {
      const raw = newItems[s.id];
      if (!raw) continue;
      // Defensive backstop: never persist hub/aggregator pages even if the
      // model slips and returns one despite the prompt instruction.
      if (s.cycleStatus === "hub") continue;
      shortlist.push({
        // Dedup by normalized award name so the same award seen at different
        // URLs merges into one row (the URL-based ledger in Step 2 stays as-is).
        awardId:             fnv1a(normalizeAwardKey(s.title)),
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
        cycleStatus:         s.cycleStatus,
        setAsideRequired:    s.setAsideRequired,
        ownerRequired:       s.ownerRequired,
        revenueCapUsd:       s.revenueCapUsd,
        applicantType:       s.applicantType,
        minYears:            s.minYears,
        maxYears:            s.maxYears,
        // Generic, eligibility-agnostic recommendation (per-subscriber match happens later).
        recommendation:      computeRecommendation(s.cycleStatus, s.fitScore),
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
          cycle_status:         a.cycleStatus,
          set_aside_required:   a.setAsideRequired,
          owner_required:       a.ownerRequired,
          revenue_cap_usd:      a.revenueCapUsd,
          applicant_type:       a.applicantType,
          min_years:            a.minYears,
          max_years:            a.maxYears,
          last_scored_at:       scoredAt,
        }));

        const res = await ctx.fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/awards?on_conflict=award_id`,
          {
            method: "POST",
            headers: sbHeaders(ctx.env, { extra: { Prefer: "resolution=merge-duplicates,return=minimal" } }),
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

      await upsertContentHashLedger(ctx, {
        table: "award_scored",
        conflictColumn: "award_id",
        profile: "orchestration",
        rows: ledgerRows,
        warnLabel: "[award-sweep] ledger insert",
      });
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
