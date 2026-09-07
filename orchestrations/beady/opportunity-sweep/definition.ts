import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { samGovOpportunitySearch, sbirTopicSearch } from "./tools";
import { sendAlertEmail, subscriptionRecipients } from "../../../integrations/resend/alert";
import { senderFor } from "../../../integrations/resend/sender";
import { sbHeaders } from "@/runtime/utils/supabase";
import { fnv1a } from "@/runtime/utils/hash";
import { loadContentHashLedger, contentChanged, upsertContentHashLedger } from "@/runtime/utils/scored-sweep";

// ─── Content fingerprinting (amendment-aware re-scoring) ────────────────────────
// A notice is re-scored only when the fields that drive its fit score change. We
// hash those fields; if the hash differs from what's in scored_notices, the notice
// was materially amended and is scored again (so monitor → pursue can happen when
// the government actually changes the solicitation). FNV-1a is plenty for change
// detection; this isn't security-sensitive.
// `description` here is the notice BODY, and is null until something fetches it.
// It must NEVER be the description URL: SAM v2's `description` field is a link, and
// that link is stable across amendments -- so including it made the hash look
// unchanged when a solicitation's text had been materially rewritten, which is
// exactly the case the re-score exists to catch. SamOpportunity now keeps
// `descriptionUrl` and `description` apart so this cannot silently regress (#219).
function samContentHash(o: { title: string; naicsCode: string | null; setAside: string | null; responseDeadline: string | null; description: string | null }): string {
  return fnv1a([o.title, o.naicsCode, o.setAside, o.responseDeadline, o.description].join(""));
}
function sbirContentHash(t: { title: string; program: string; phase: string; closeDate: string | null; abstract: string | null }): string {
  return fnv1a([t.title, t.program, t.phase, t.closeDate, t.abstract].join(""));
}

// How many notices go into one scoring prompt, and how much room the answer gets.
//
// Both numbers are now MEASURED rather than guessed, from six production batches:
//
//   147 output tokens per notice      (I had assumed 80)
//   3.3 seconds per notice, 44 tok/s  (I had assumed 8)
//
// So a 40-notice batch is ~5,900 tokens in ~133s. That fits the 16384 cap nearly
// three times over and the 300s Anthropic timeout more than twice, and it explains
// the original failure exactly: 40 x 147 = 5,880 tokens against the old default
// 4096 cap, truncated mid-array.
//
// The batch was cut to 20 on that bad arithmetic, which traded a token problem for
// a worse one. Workers allows 50 subrequests per invocation and each scoring batch
// is one llm_extract costing 3, so halving the batch size raised the batch count
// from 4 to 7 and pushed the sweep past the wall -- it died entering the last
// batch, having scored 133 notices it then threw away.
//
// Bigger batches are CHEAPER here, and 60 is where the three constraints meet at
// the designed limit of 250 notices:
//
//   subrequests  ceil(250/60) = 5 batches x 3 = 15, leaving real headroom under 50
//   tokens       60 x 147   = 8,820   vs 16384 cap   (1.9x)
//   wall clock   60 x 3.3s  = 198s    vs 300s timeout (1.5x)
//
// runtime/tests/unit/sweep-subrequest-budget.test.ts holds that arithmetic, so
// halving this again fails CI instead of production.
/**
 * Whether to call the DoD SBIR/STTR source at all.
 *
 * It has returned 403 on every run since 2026-07: the portal moved to
 * www.defensesbirsttr.mil behind Akamai bot protection and the SBIR.gov public API
 * is disabled (#63). The sweep already treats this as a known outage and
 * deliberately does not alert on it.
 *
 * Confirming a known outage cost 4 subrequests a run -- the defineTool bookkeeping
 * pair, a budget claim, and the fetch that 403s -- out of a 50-per-invocation
 * Worker budget that the sweep has been exhausting. That is 8% of the run's total
 * resource spent learning something we already know.
 *
 * Flip this to true the moment a working SBIR source exists; the code path is
 * unchanged and still tested. Until then the sweep reports sbirFound: 0, which is
 * exactly what it reported when the call was being made.
 */
export const SBIR_SOURCE_AVAILABLE = false;

export const SCORE_BATCH_SIZE = 60;
export const SCORE_MAX_TOKENS = 16384;

/**
 * Scoring gets a longer per-request timeout than the 300s default.
 *
 * The default exists to stop a STALLED request holding a step open (#193), and it
 * cannot tell a stall from a call that is legitimately long. Scoring is the latter,
 * and its cost grows worse than linearly in batch size: 20 notices took 66s (3.3s
 * each), 60 ran past 308s (>5.1s each) because the model attends over a longer
 * context as well as writing more.
 *
 * Raising the timeout is the right lever rather than shrinking the batch. Smaller
 * batches mean more llm_extract calls, and each one costs 3 subrequests against a
 * ceiling of 50 -- the scarcer resource, and the one that has actually killed runs.
 * 600s is ~1.7x the projected 350s for a full batch.
 */
export const SCORE_TIMEOUT_MS = 600_000;

const scoreSchema = z.object({
  scored: z.array(
    z.object({
      id: z.string(),
      fitScore: z.number().int().min(1).max(10),
      fitReason: z.string(),
      redFlags: z.string().nullable(),
    }),
  ),
});

// `recommendation` was asked of the model alongside the score, under a rule that
// made it a restatement of the score: pursue >= 7, monitor 5-6, pass <= 4. It came
// back obeying that rule on every row, so the column presented itself on the card as
// a second, independent judgement while carrying nothing the score did not. Deriving
// it here says the same thing honestly, costs no output tokens, and removes the case
// where a model returns 'pursue' on a fit of 3.
//
// This stays a band of the score until #197 gives it a real second axis (Tommy's
// bid/no-bid gates: past-performance count, demo requirement, LPTA).
/**
 * Which sub-floor notices are worth a demotion PATCH: only the ones already in
 * `opportunities`. A notice that scored below the floor and was never stored has
 * nothing to demote, and patching it is a request that cannot match a row.
 *
 * Trivial as logic, expensive as a mistake -- #211 skipped the intersection and
 * patched all ~100 sub-floor notices of a first sweep, blowing Cloudflare's
 * per-invocation subrequest limit after every batch had already been scored.
 */
export function selectDemotions<T extends { id: string }>(subFloor: T[], stored: Set<string>): T[] {
  return subFloor.filter((r) => stored.has(r.id));
}

export function recommendationFor(fitScore: number): "pursue" | "monitor" | "pass" {
  if (fitScore >= 7) return "pursue";
  if (fitScore >= 5) return "monitor";
  return "pass";
}

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
  postedWithinDays: z.number().int().min(1).max(90).default(30).describe("Only sweep notices posted in the last N days."),
  minScore: z.number().int().min(1).max(10).default(5).describe("Minimum fit score to keep an opportunity."),
  samLimit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(250)
    .describe("Max SAM.gov notices to pull per sweep. Only net-new notices reach the LLM (scored_notices dedupes), so this bounds the first sweep after a filter change far more than a steady-state daily run."),
  sbirLimit: z.number().int().min(1).max(200).default(50).describe("Max SBIR topics to pull per sweep."),
  samNoticeTypes: z
    .array(z.string())
    .default(["o", "p", "r"])
    .describe("SAM notice types to sweep: o=Solicitation, p=Presolicitation, r=Sources Sought (RFIs). Capturing p+r surfaces RFIs/market-research notices, not just full solicitations."),
});

const scoredOpportunitySchema = z.object({
  externalId: z.string().describe("sam_notice_id value used for DB upsert"),
  source: z.enum(["sam_gov", "sbir"]),
  title: z.string(),
  agency: z.string().nullable(),
  setAside: z.string().nullable(),
  responseDeadline: z.string().nullable(),
  sourceUrl: z.string(),
  noticeType: z.string().nullable(),
  fitScore: z.number().int().min(1).max(10),
  fitReason: z.string(),
  redFlags: z.string().nullable(),
  recommendation: z.enum(["pursue", "monitor", "pass"]),
});

export const outputSchema = z.object({
  // The funnel, stage by stage. samFound alone hid the fact that the sweep was
  // scoring 50 of ~8,500 matching notices; a sweep that sees N and keeps M should
  // say both out loud.
  samFound: z.number().describe("Notices SAM reports as matching the query (the match set)."),
  samMatchedByNaics: z.record(z.number()).optional().describe("Match-set size per NAICS code searched."),
  samPulled: z.number().describe("Notices actually pulled from SAM, after `samLimit`."),
  samNew: z.number().describe("Of those, the ones not already scored (or amended since)."),
  samTruncated: z.boolean().describe("True when the match set was larger than `samLimit` allowed us to pull."),
  // The full 1-10 histogram, INCLUDING scores below minScore, which are scored and
  // counted but not stored as opportunities. Without this there is no way to ask
  // whether the floor is set right: the sub-floor scores exist nowhere else (#206).
  scoreDistribution: z.record(z.number()).optional().describe("Count of notices at each fit score 1-10, before the minScore cut."),
  belowFloor: z.number().describe("Scored notices that fell below minScore and were not stored."),
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
  // Replace the two individual Monday crons: this one sweep covers both sources
  cron: "0 8 * * 1",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input) {
    // Step 1: Fetch both sources (resilient, so one source failing or hitting its
    // budget cap doesn't kill the other), then drop opportunities we've already
    // scored so only net-new items reach the LLM.
    const { samResults, sbirResults, samPulled, samError, sbirError } = await step(ctx, "fetch-both-sources", async () => {
      const [samR, sbirR] = await Promise.allSettled([
        samGovOpportunitySearch(ctx, {
          keywords: input.keywords,
          naicsCodes: input.naicsCodes,
          agencies: input.agencies,
          postedWithinDays: input.postedWithinDays,
          limit: input.samLimit,
          openOnly: true,
          ptypes: input.samNoticeTypes,
        }),
        SBIR_SOURCE_AVAILABLE
          ? sbirTopicSearch(ctx, {
              keyword: input.keywords,
              component: input.sbirComponents,
              topicStatus: "Open",
              limit: input.sbirLimit,
            })
          : Promise.resolve({ totalElements: 0, topics: [] }),
      ]);
      const samResults = samR.status === "fulfilled"
        ? samR.value
        : { totalRecords: 0, matchedByNaics: {} as Record<string, number>, fetched: 0, requests: 0, truncated: false, opportunities: [] };
      const sbirResults = sbirR.status === "fulfilled" ? sbirR.value : { totalElements: 0, topics: [] };
      if (samR.status === "rejected") console.warn("[sweep] SAM.gov fetch skipped:", samR.reason);
      if (sbirR.status === "rejected") console.warn("[sweep] SBIR fetch skipped:", sbirR.reason);

      // Dedupe against the scored_notices ledger. A notice is skipped only if we've
      // already scored it AND its content fingerprint is unchanged. If the hash
      // differs the solicitation was amended, so we re-score it. notice_id is the
      // raw SAM.gov noticeId, or `sbir_<topicNumber>` for SBIR/STTR topics.
      const ledger = await loadContentHashLedger(ctx, {
        table: "scored_notices",
        keyColumn: "notice_id",
        profile: "orchestration",
        warnLabel: "[sweep] dedupe lookup failed, scoring all results:",
      });

      // Score a notice if it's new, or if its content hash changed (amended).
      const changed = (id: string, hash: string) => contentChanged(ledger, id, hash);

      return {
        samResults: { ...samResults, opportunities: samResults.opportunities.filter((o) => changed(o.noticeId, samContentHash(o))) },
        sbirResults: { ...sbirResults, topics: sbirResults.topics.filter((t) => changed(`sbir_${t.topicNumber}`, sbirContentHash(t))) },
        // Pulled count is taken before the dedupe filter above, so the run summary
        // can distinguish "SAM had nothing new" from "we pulled nothing".
        samPulled: samResults.opportunities.length,
        samError: samR.status === "rejected" ? String(samR.reason) : null,
        sbirError: sbirR.status === "rejected" ? String(sbirR.reason) : null,
      };
    });

    // Health alert: a source failure or a suspiciously empty sweep (e.g. an expired
    // SAM key). Otherwise the run silently "completes" with 0 and no one notices.
    await step(ctx, "sweep-health-alert", async () => {
      const samCount = samResults.totalRecords;
      const sbirCount = sbirResults.totalElements;

      // Only SAM problems are actionable and alert-worthy. SBIR is a known-degraded
      // external source (the DoD portal moved behind Akamai bot-protection); we record
      // its status in this step but don't email about it every run. Re-enable SBIR
      // alerting once a working SBIR source is restored.
      const issues: string[] = [];
      if (samError) issues.push(`SAM.gov source FAILED: ${samError.slice(0, 300)}`);
      else if (samCount === 0) issues.push("SAM.gov returned 0 matching notices. Either every filter is wrong or the key/API is down.");
      // Truncation is not a failure, but it is the thing that silently degraded this
      // sweep for months, so it gets said out loud rather than left in runs.output.
      if (samResults.truncated) {
        issues.push(
          `SAM.gov match set (${samCount}) is larger than samLimit allowed us to pull (${samResults.fetched}). ` +
          `The sweep is sampling, not sweeping. Per NAICS: ${JSON.stringify(samResults.matchedByNaics)}.`,
        );
      }

      if (issues.length === 0) {
        return { alerted: false, samCount, sbirCount, sbirError: sbirError ?? null };
      }

      const authHint = samError && /\b40[13]\b/.test(samError)
        ? "\n\nA 401/403 from SAM usually means SAM_GOV_API_KEY expired (SAM rotates keys ~every 90 days). Renew it, then: wrangler secret put SAM_GOV_API_KEY."
        : "";
      const sbirNote = sbirError ? "\n\n(SBIR is separately unavailable: known external issue, not alerting on it.)" : "";
      const text = `Beady opportunity-sweep health alert\n\n- ${issues.join("\n- ")}\n\nThis run had SAM: ${samCount}, SBIR: ${sbirCount}.${authHint}${sbirNote}`;

      // Alert the people subscribed to the opportunity digest; they're the ones a
      // broken sweep affects.
      const to = await subscriptionRecipients(ctx.env, "opportunity");
      const result = await sendAlertEmail(ctx.env, { to, subject: "⚠️ Beady sweep health alert", text, from: senderFor(ctx.env, "beady") });
      return { alerted: result.sent, recipients: result.recipients, reason: result.error, issues };
    });

    const totalFound = samResults.opportunities.length + sbirResults.topics.length;
    if (totalFound === 0) {
      return {
        samFound: samResults.totalRecords,
        samMatchedByNaics: samResults.matchedByNaics,
        samPulled,
        samNew: 0,
        samTruncated: samResults.truncated,
        scoreDistribution: {},
        belowFloor: 0,
        sbirFound: sbirResults.totalElements,
        shortlistCount: 0,
        opportunities: [],
      };
    }

    // Step 2: Score every net-new notice. Batched, because a sweep that actually
    // covers its match set can hand this step a few hundred notices, and one prompt
    // holding all of them risks a truncated response or a request slow enough to
    // trip the Anthropic timeout. Batches run in order so each llm_extract lands on
    // a stable step index and the run can still be replayed.
    const toScore = [
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
        naicsCode: null as string | null,
        setAside: `${t.program} ${t.phase}`,
        deadline: t.closeDate,
        description: t.abstract,
      })),
    ];
    const batches: (typeof toScore)[] = [];
    for (let i = 0; i < toScore.length; i += SCORE_BATCH_SIZE) {
      batches.push(toScore.slice(i, i + SCORE_BATCH_SIZE));
    }

    const scoredRows: z.infer<typeof scoreSchema>["scored"] = [];
    for (const [i, batch] of batches.entries()) {
      const result = await llm_extract(ctx, {
        name: batches.length === 1 ? "score-all-opportunities" : `score-opportunities-${i + 1}-of-${batches.length}`,
        prompt: `
You are Beady, Lumiture's BD AI. Score each opportunity below against Lumiture's profile.
Opportunities come from two sources: SAM.gov (traditional contracts) and DoD SBIR/STTR (R&D
solicitations). Apply the same scoring logic to both. SBIR topics are R&D-focused so expect
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

Score EVERY opportunity in the input and return one entry for each, including the ones
you score 1. Do not filter, rank or omit anything: what to keep is decided downstream.
        `.trim(),
        input: { opportunities: batch },
        schema: scoreSchema,
        maxTokens: SCORE_MAX_TOKENS,
        timeoutMs: SCORE_TIMEOUT_MS,
      });
      scoredRows.push(...result.scored);
    }

    const scoreMap = new Map(scoredRows.map((s) => [s.id, s]));

    // Record every notice we just scored in the dedup ledger so it is never
    // re-scored on a later run. The model now returns a score for every input, so
    // this records the real number even for notices that fall below the save floor.
    // That is the point: the ledger is the only place the sub-floor scores exist,
    // and without them there is no way to ask whether the floor is set right (#206).
    // A null fit_score here means the model omitted the item despite being told not
    // to, not that it scored low.
    await step(ctx, "record-scored-notices", async () => {
      const scoredAt = new Date().toISOString();
      const rows = [
        ...samResults.opportunities.map((o) => {
          const s = scoreMap.get(`sam_${o.noticeId}`);
          return { notice_id: o.noticeId, source: "sam_gov", fit_score: s?.fitScore ?? null, recommendation: s ? recommendationFor(s.fitScore) : "pass", content_hash: samContentHash(o), scored_at: scoredAt };
        }),
        ...sbirResults.topics.map((t) => {
          const s = scoreMap.get(`sbir_${t.topicNumber}`);
          return { notice_id: `sbir_${t.topicNumber}`, source: "sbir", fit_score: s?.fitScore ?? null, recommendation: s ? recommendationFor(s.fitScore) : "pass", content_hash: sbirContentHash(t), scored_at: scoredAt };
        }),
      ];
      if (rows.length === 0) return;
      // merge-duplicates: a re-scored (amended) notice updates its existing row with
      // the new score, recommendation, hash and timestamp.
      await upsertContentHashLedger(ctx, {
        table: "scored_notices",
        conflictColumn: "notice_id",
        profile: "orchestration",
        rows,
        warnLabel: "[sweep] scored_notices insert",
      });
    });

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
        noticeType: opp.noticeType,
        recommendation: recommendationFor(score.fitScore),
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
        noticeType: "SBIR/STTR Topic",
        recommendation: recommendationFor(score.fitScore),
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
              notice_type:        o.noticeType,
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
              notice_type:        o.noticeType,
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
            headers: sbHeaders(ctx.env, { extra: { Prefer: "resolution=merge-duplicates" } }),
            body: JSON.stringify(rows),
          },
        );

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Supabase upsert → ${res.status}: ${text}`);
        }
      });
    }

    // Step 4: Demote anything ALREADY STORED that was re-scored below the save floor.
    // This is an amended solicitation whose fit narrowed -- symmetric to a monitor
    // climbing to pursue.
    //
    // We mark rather than delete: assessments, incumbent_research and documents FK to
    // opportunities (ON DELETE CASCADE), so a delete would wipe analyst work. A
    // demoted row is preserved but excluded from reports.
    //
    // Demoted rows carry their REAL new score. Before #206 the model returned only the
    // shortlist, so a demotion knew a notice had fallen below the floor but not to
    // what, and left a stale fit_score next to recommendation='pass' -- a row
    // disagreeing with itself.
    //
    // "Already stored" is the load-bearing word, and getting it wrong cost a
    // production run. #211 patched every sub-floor notice, one request each, on the
    // theory that a sub-floor re-score is rare. It is rare among STORED rows. Among
    // freshly scored ones it is most of the sweep -- 100-odd notices, none of which
    // exist in the table, each getting its own PATCH that could not match anything.
    // That blew Cloudflare's per-invocation subrequest limit and killed the run after
    // every batch had been scored. One SELECT to find the intersection first, then a
    // PATCH only for rows that are genuinely there.
    const subFloor = [
      ...samResults.opportunities
        .map((op) => ({ id: op.noticeId, score: scoreMap.get(`sam_${op.noticeId}`) }))
        .filter((r) => r.score !== undefined && r.score.fitScore < input.minScore),
      ...sbirResults.topics
        .map((t) => ({ id: `sbir_${t.topicNumber}`, score: scoreMap.get(`sbir_${t.topicNumber}`) }))
        .filter((r) => r.score !== undefined && r.score.fitScore < input.minScore),
    ];
    if (subFloor.length > 0) {
      await step(ctx, "demote-rescored-to-pass", async () => {
        const inList = subFloor.map((r) => `"${r.id}"`).join(",");
        const found = await ctx.fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/opportunities?sam_notice_id=in.(${inList})&select=sam_notice_id`,
          { headers: sbHeaders(ctx.env) },
        );
        if (!found.ok) {
          console.warn(`[sweep] demote lookup → ${found.status}: ${await found.text()}`);
          return { demoted: 0, subFloor: subFloor.length };
        }
        const stored = new Set(((await found.json()) as { sam_notice_id: string }[]).map((r) => r.sam_notice_id));
        const toDemote = selectDemotions(subFloor, stored);

        const demotedAt = new Date().toISOString();
        // One PATCH per row, because each carries its own new score -- but now only
        // over rows that exist, which is genuinely the handful the comment claims.
        for (const { id, score } of toDemote) {
          const res = await ctx.fetch(
            `${ctx.env.SUPABASE_URL}/rest/v1/opportunities?sam_notice_id=eq.${encodeURIComponent(id)}`,
            {
              method: "PATCH",
              headers: sbHeaders(ctx.env, { extra: { Prefer: "return=minimal" } }),
              body: JSON.stringify({
                recommendation: "pass",
                fit_score: score!.fitScore,
                fit_reason: score!.fitReason,
                red_flags: score!.redFlags,
                last_scored_at: demotedAt,
              }),
            },
          );
          if (!res.ok) console.warn(`[sweep] demote ${id} → ${res.status}: ${await res.text()}`);
        }
        return { demoted: toDemote.length, subFloor: subFloor.length };
      });
    }

    const scoreDistribution = scoredRows.reduce<Record<string, number>>((acc, r) => {
      acc[String(r.fitScore)] = (acc[String(r.fitScore)] ?? 0) + 1;
      return acc;
    }, {});

    return {
      samFound: samResults.totalRecords,
      samMatchedByNaics: samResults.matchedByNaics,
      samPulled,
      samNew: samResults.opportunities.length,
      samTruncated: samResults.truncated,
      scoreDistribution,
      belowFloor: scoredRows.filter((r) => r.fitScore < input.minScore).length,
      sbirFound: sbirResults.totalElements,
      shortlistCount: shortlisted.length,
      opportunities: shortlisted,
    };
  },
});
