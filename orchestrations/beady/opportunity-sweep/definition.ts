import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { samGovOpportunitySearch, sbirTopicSearch } from "./tools";
import { sendAlertEmail, subscriptionRecipients } from "../../../integrations/resend/alert";
import { senderFor } from "../../../integrations/resend/sender";

// ─── Content fingerprinting (amendment-aware re-scoring) ────────────────────────
// A notice is re-scored only when the fields that drive its fit score change. We
// hash those fields; if the hash differs from what's in scored_notices, the notice
// was materially amended and is scored again (so monitor → pursue can happen when
// the government actually changes the solicitation). FNV-1a is plenty for change
// detection; this isn't security-sensitive.
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
function samContentHash(o: { title: string; naicsCode: string | null; setAside: string | null; responseDeadline: string | null; description: string | null }): string {
  return fnv1a([o.title, o.naicsCode, o.setAside, o.responseDeadline, o.description].join(""));
}
function sbirContentHash(t: { title: string; program: string; phase: string; closeDate: string | null; abstract: string | null }): string {
  return fnv1a([t.title, t.program, t.phase, t.closeDate, t.abstract].join(""));
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
  postedWithinDays: z.number().int().min(1).max(90).default(30),
  minScore: z.number().int().min(1).max(10).default(5),
  samLimit: z.number().int().min(1).max(50).default(50),
  sbirLimit: z.number().int().min(1).max(200).default(50),
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
    const { samResults, sbirResults, samError, sbirError } = await step(ctx, "fetch-both-sources", async () => {
      const [samR, sbirR] = await Promise.allSettled([
        samGovOpportunitySearch(ctx, {
          keywords: input.keywords,
          naicsCodes: input.naicsCodes,
          agencies: input.agencies,
          postedWithinDays: input.postedWithinDays,
          limit: input.samLimit,
          activeOnly: true,
          ptypes: input.samNoticeTypes,
        }),
        sbirTopicSearch(ctx, {
          keyword: input.keywords,
          component: input.sbirComponents,
          topicStatus: "Open",
          limit: input.sbirLimit,
        }),
      ]);
      const samResults = samR.status === "fulfilled" ? samR.value : { totalRecords: 0, opportunities: [] };
      const sbirResults = sbirR.status === "fulfilled" ? sbirR.value : { totalElements: 0, topics: [] };
      if (samR.status === "rejected") console.warn("[sweep] SAM.gov fetch skipped:", samR.reason);
      if (sbirR.status === "rejected") console.warn("[sweep] SBIR fetch skipped:", sbirR.reason);

      // Dedupe against the scored_notices ledger. A notice is skipped only if we've
      // already scored it AND its content fingerprint is unchanged. If the hash
      // differs the solicitation was amended, so we re-score it. notice_id is the
      // raw SAM.gov noticeId, or `sbir_<topicNumber>` for SBIR/STTR topics.
      const ledger = new Map<string, string | null>(); // notice_id → last content_hash
      try {
        const res = await ctx.fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/scored_notices?select=notice_id,content_hash`,
          { headers: { apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`, "Accept-Profile": "orchestration" } },
        );
        if (res.ok) for (const row of (await res.json()) as Array<{ notice_id: string | null; content_hash: string | null }>) {
          if (row.notice_id) ledger.set(row.notice_id, row.content_hash);
        }
      } catch (e) {
        console.warn("[sweep] dedupe lookup failed, scoring all results:", e);
      }

      // Score a notice if it's new, or if its content hash changed (amended).
      const changed = (id: string, hash: string) => !ledger.has(id) || ledger.get(id) !== hash;

      return {
        samResults: { ...samResults, opportunities: samResults.opportunities.filter((o) => changed(o.noticeId, samContentHash(o))) },
        sbirResults: { ...sbirResults, topics: sbirResults.topics.filter((t) => changed(`sbir_${t.topicNumber}`, sbirContentHash(t))) },
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
      else if (samCount === 0) issues.push("SAM.gov returned 0 results (normally ~thousands, so this is likely an API/key issue).");

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
      return { samFound: 0, sbirFound: 0, shortlistCount: 0, opportunities: [] };
    }

    // Step 2: Score all results together in one LLM call
    const scored = await llm_extract(ctx, {
      name: "score-all-opportunities",
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

    // Record every notice we just scored (pass or pursue) in the dedup ledger so it
    // is never re-scored on a later run. Items below minScore aren't in scoreMap
    // (the model only returns the shortlist), so they're logged as recommendation
    // 'pass' with a null score, but they were still evaluated.
    await step(ctx, "record-scored-notices", async () => {
      const scoredAt = new Date().toISOString();
      const rows = [
        ...samResults.opportunities.map((o) => {
          const s = scoreMap.get(`sam_${o.noticeId}`);
          return { notice_id: o.noticeId, source: "sam_gov", fit_score: s?.fitScore ?? null, recommendation: s?.recommendation ?? "pass", content_hash: samContentHash(o), scored_at: scoredAt };
        }),
        ...sbirResults.topics.map((t) => {
          const s = scoreMap.get(`sbir_${t.topicNumber}`);
          return { notice_id: `sbir_${t.topicNumber}`, source: "sbir", fit_score: s?.fitScore ?? null, recommendation: s?.recommendation ?? "pass", content_hash: sbirContentHash(t), scored_at: scoredAt };
        }),
      ];
      if (rows.length === 0) return;
      // merge-duplicates: a re-scored (amended) notice updates its existing row with
      // the new score, recommendation, hash and timestamp.
      const res = await ctx.fetch(
        `${ctx.env.SUPABASE_URL}/rest/v1/scored_notices?on_conflict=notice_id`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Profile": "orchestration",
            Prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify(rows),
        },
      );
      if (!res.ok) console.warn(`[sweep] scored_notices insert → ${res.status}: ${await res.text()}`);
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
              notice_type:        o.noticeType,
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

    // Step 4: Demote anything that was re-scored down to pass. Re-scored notices not
    // in scoreMap fell below the save floor (the model only returns fitScore >= minScore).
    // For any that already exist in opportunities (a prior pursue/monitor whose
    // amendment narrowed its fit), flip them to recommendation='pass' so reports drop
    // them, symmetric to a monitor climbing to pursue. New sub-floor notices that were
    // never saved simply match nothing here. We mark rather than delete: assessments,
    // incumbent_research and documents FK to opportunities (ON DELETE CASCADE), so a
    // delete would wipe analyst work; a demoted row is preserved but excluded from reports.
    const demotedIds = [
      ...samResults.opportunities.filter((o) => !scoreMap.has(`sam_${o.noticeId}`)).map((o) => o.noticeId),
      ...sbirResults.topics.filter((t) => !scoreMap.has(`sbir_${t.topicNumber}`)).map((t) => `sbir_${t.topicNumber}`),
    ];
    if (demotedIds.length > 0) {
      await step(ctx, "demote-rescored-to-pass", async () => {
        const inList = demotedIds.map((id) => `"${id}"`).join(",");
        const res = await ctx.fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/opportunities?sam_notice_id=in.(${inList})`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
              Prefer: "return=minimal",
            },
            body: JSON.stringify({ recommendation: "pass", last_scored_at: new Date().toISOString() }),
          },
        );
        if (!res.ok) console.warn(`[sweep] demote re-scored → ${res.status}: ${await res.text()}`);
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
