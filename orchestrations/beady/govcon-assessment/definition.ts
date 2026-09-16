import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import type { Env } from "@/runtime";
import { scopeForRun } from "@/runtime/agents/knowledge-access";
import { fetchOpportunityAttachmentText } from "../../../integrations/sam-gov/attachments";
import type { KnowledgeScope } from "@/runtime/agents/knowledge-access";
import {
  pdfToText,
  extractOpportunityFacts,
  scoreQualification,
  scoreDimension,
  writeExecutiveMemo,
  DIMENSION_SYSTEMS,
} from "../../../integrations/anthropic/govcon";
import { tavilySearch } from "../../../integrations/tavily/search";
import {
  buildEvaluationPayload,
  computeWeightedScore,
  buildDimensionContext,
  buildIncumbentQueries,
  buildD3Prompt,
  computeStrategicScores,
  assembleFinalResult,
} from "./scoring";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const inputSchema = z.object({
  opportunityId: z.string().uuid().optional().describe("Existing opportunities row to assess (e.g. from beady/opportunity-sweep). If omitted or not found, a new row is created from the intake text/PDF."),
  opportunityName: z.string().optional().describe("Opportunity title, used when creating a new opportunity"),
  summaryText: z.string().optional().describe("Solicitation abstract / analyst summary"),
  notes: z.string().optional().describe("Extra analyst context"),
  solicitationPdfBase64: z.string().optional().describe("Base64 solicitation PDF, injected automatically from chat attachments (single file)"),
});

export const outputSchema = z.object({
  assessmentId: z.string().uuid(),
  opportunityId: z.string().uuid(),
  overallScore: z.number().describe("Qualification engine, 0–100"),
  strategicScore: z.number().describe("Strategic D1–D5 engine, 0–100"),
  goNoGo: z.string().describe("GO | CONDITIONAL | NO GO"),
  recommendedPosture: z.string(),
  executiveMemo: z.string(),
});

// ─── Supabase REST helpers ──────────────────────────────────────────────────────

function headers(env: Env, profile?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...(profile ? { "Content-Profile": profile, "Accept-Profile": profile } : {}),
  };
}

async function sbSelect(env: Env, query: string): Promise<any[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${query}`, { headers: headers(env) });
  if (!res.ok) throw new Error(`Supabase GET ${query} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<any[]>;
}

async function sbInsert(env: Env, table: string, row: any, returning = false): Promise<any> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...headers(env), Prefer: returning ? "return=representation" : "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase INSERT ${table} → ${res.status}: ${await res.text()}`);
  return returning ? ((await res.json()) as any[])[0] : null;
}

async function sbUpdate(env: Env, table: string, id: string, patch: any): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...headers(env), Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase UPDATE ${table} → ${res.status}: ${await res.text()}`);
}

// Workers AI embeddings + pgvector retrieval over the shared corpus (bge-1024).
async function embed(env: Env, text: string): Promise<number[]> {
  const ai = env.AI as unknown as { run: (m: string, i: { text: string[] }) => Promise<{ data: number[][] }> };
  const r = await ai.run("@cf/baai/bge-large-en-v1.5", { text: [text] });
  return r.data[0] ?? [];
}

async function matchChunks(
  env: Env,
  queryText: string,
  scope: KnowledgeScope,
  k = 5,
): Promise<Array<{ content: string; similarity: number; source_name: string }>> {
  try {
    const emb = await embed(env, queryText);
    if (!emb.length) return [];
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_document_chunks`, {
      method: "POST",
      headers: headers(env, "orchestration"),
      // Scope comes from the shared helper so this call site cannot drift from the
      // agent access policy. It previously hardcoded the corpora, which happened to
      // match but would silently keep stale rules if the policy ever changed.
      body: JSON.stringify({
        query_embedding: `[${emb.join(",")}]`,
        match_count: k,
        min_similarity: 0.3,
        allowed_corpora: scope.allowedCorpora,
        include_restricted: scope.includeRestricted,
      }),
    });
    if (!res.ok) return [];
    return (await res.json()) as any[];
  } catch {
    return [];
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "beady/govcon-assessment",
  version: 1,
  description:
    "Full GovCon qualification assessment: extracts opportunity facts, runs both the 9-category Qualification score and the D1–D5 Strategic score (with Tavily incumbent research and RAG over past performance), writes an executive memo, and saves to assessments.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const env = ctx.env;
    const model = ctx.model;

    // ── 1. Resolve / create the opportunity, ingest documents ──────────────────
    const { opportunityId } = await step(ctx, "resolve-opportunity", async () => {
      // Resolve the opportunity FIRST: what we can fetch depends on knowing its
      // sam_notice_id, and until #<this change> the order was the other way round.
      let opp: any = null;
      if (input.opportunityId) {
        const rows = await sbSelect(env, `opportunities?id=eq.${input.opportunityId}&select=*&limit=1`);
        opp = rows[0] ?? null;
      }

      const docs: Array<{ doc_type: string; text: string }> = [];
      if (input.solicitationPdfBase64) {
        const pdfText = await pdfToText(env, input.solicitationPdfBase64);
        if (pdfText.trim()) docs.push({ doc_type: "rfp_pdf", text: pdfText.trim() });
      }
      if (input.summaryText?.trim()) docs.push({ doc_type: "summary", text: input.summaryText.trim() });
      if (input.notes?.trim()) docs.push({ doc_type: "capture_brief", text: input.notes.trim() });

      // Pull the actual solicitation from SAM.gov when nothing was supplied by hand.
      //
      // Without this, running the assessment on an existing opportunity gave the model
      // a title, an agency and a 224-character fit rationale -- so extractOpportunityFacts
      // was never even called (it is gated on there being text), every extraction field
      // stayed null, and the memo correctly reported the opportunity as "a black box".
      // The capability existed: fetchOpportunityAttachmentText resolves the notice
      // description and its resourceLinks, and was wired into beady/rfi-draft only.
      //
      // Best-effort by design. A solicitation we cannot fetch should degrade to the old
      // metadata-only assessment, not fail the run -- the memo already says how confident
      // it is, and "Very Low" on thin input is the right answer rather than an error.
      if (!docs.some((d) => d.doc_type === "rfp_pdf") && opp?.sam_notice_id) {
        const noticeId = String(opp.sam_notice_id);
        // Only SAM notice ids resolve in SAM. sam_notice_id is the generic external
        // id -- `sbir_<topic>`, `govwin_<Opp ID>` -- and handing one of those to the
        // SAM search spends a request against the shared daily quota to be told
        // "notice not found", which then reads like a missing solicitation rather
        // than a source that was never SAM's to begin with.
        if (!/^(sbir|govwin)_/.test(noticeId)) {
          const attachment = await fetchOpportunityAttachmentText(
            env,
            noticeId,
            (opp.posted_date as string | null) ?? null,
          ).catch((e: unknown) => ({ text: "", note: `error: ${e instanceof Error ? e.message : String(e)}` }));
          if (attachment.text.trim()) {
            docs.push({ doc_type: "solicitation", text: attachment.text.trim() });
          }
          console.log(`[govcon-assessment] solicitation fetch for ${noticeId}: ${attachment.note}`);
        }
      }

      const combinedText = docs.map((d) => `[${d.doc_type.toUpperCase()}]\n${d.text}`).join("\n\n---\n\n");

      let facts: any = null;
      if (combinedText) facts = await extractOpportunityFacts(env, combinedText, model);

      if (opp) {
        if (facts) {
          const patch: any = {};
          for (const f of ["agency", "vehicle", "set_aside", "contract_type", "pop", "estimated_fte_range", "evaluation_basis"] as const) {
            if ((!opp[f] || opp[f] === "Unknown") && facts[f]) patch[f] = facts[f];
          }
          if ((!opp.key_requirements || opp.key_requirements.length === 0) && facts.key_requirements?.length) patch.key_requirements = facts.key_requirements;
          // Bid-gate inputs (#197). The scoring engine has read these columns all
          // along (scoring.ts) and nothing ever wrote them, so Tommy's Options 1 and 2
          // could not be evaluated on any opportunity. requires_demo stays in
          // extracted_facts, merged below.
          for (const f of ["num_past_performances_required", "num_key_personnel_required"] as const) {
            if (opp[f] == null && facts[f] != null) patch[f] = facts[f];
          }
          if (!opp.due_date && facts.due_date && facts.due_date !== "Unknown") patch.due_date = facts.due_date;
          // The sweep stores the deadline as `response_deadline`; the assessment reads
          // `due_date`. The SSA memo listed the due date as unknown while
          // response_deadline sat populated in the same row. Carry it across rather
          // than asking the model to rediscover a fact we already have.
          if (!patch.due_date && !opp.due_date && opp.response_deadline) {
            patch.due_date = String(opp.response_deadline).slice(0, 10);
          }
          patch.extracted_facts = { ...(opp.extracted_facts || {}), ...facts };
          if (Object.keys(patch).length) {
            await sbUpdate(env, "opportunities", opp.id, patch);
            opp = { ...opp, ...patch };
          }
        }
      } else {
        if (!facts) throw new Error("No opportunity found and no intake text/PDF provided to create one.");
        opp = await sbInsert(env, "opportunities", {
          opportunity_name: input.opportunityName || "Unnamed Opportunity",
          agency: facts.agency,
          vehicle: facts.vehicle,
          set_aside: facts.set_aside,
          contract_type: facts.contract_type,
          pop: facts.pop,
          due_date: facts.due_date && facts.due_date !== "Unknown" ? facts.due_date : null,
          estimated_fte_range: facts.estimated_fte_range,
          key_requirements: facts.key_requirements,
          evaluation_basis: facts.evaluation_basis,
          extracted_facts: facts,
          source: "agent",
        }, true);
      }

      for (const d of docs) {
        await sbInsert(env, "opportunity_documents", {
          opportunity_id: opp.id,
          doc_type: d.doc_type,
          source_name: d.doc_type,
          raw_text: d.text,
          metadata: { opportunity_id: opp.id, doc_type: d.doc_type },
        });
      }

      return { opportunityId: opp.id as string };
    });

    // ── 2. Gather company context + RAG evidence ───────────────────────────────
    const context = await step(ctx, "gather-context", async () => {
      const oppRows = await sbSelect(env, `opportunities?id=eq.${opportunityId}&select=*&limit=1`);
      const opp = oppRows[0];
      if (!opp) throw new Error("Opportunity vanished after creation");
      const docs = await sbSelect(env, `opportunity_documents?opportunity_id=eq.${opportunityId}&select=*`);
      const companies = await sbSelect(env, `company_profiles?select=*&limit=1`);
      const company = companies[0] || {};
      const companyId = company.id;
      const pp = companyId ? await sbSelect(env, `past_performance?company_profile_id=eq.${companyId}&select=*`) : [];
      const caps = companyId ? await sbSelect(env, `capability_statements?company_profile_id=eq.${companyId}&select=*`) : [];
      const icpRows = companyId ? await sbSelect(env, `icp_profiles?company_profile_id=eq.${companyId}&select=*&limit=1`) : [];
      const prompts = await sbSelect(env, `prompt_bank?is_active=eq.true&select=*`);

      const queries = [
        `${opp.opportunity_name} statement of work technical requirements tasks deliverables labor categories`,
        `${opp.opportunity_name} evaluation criteria best value past performance management staffing`,
        `${opp.agency || ""} mission objectives operating environment compliance security`,
      ];
      // Retrieval runs under the CALLER's scope (#177), not beady's own, so a config
      // agent that wires this orchestration cannot read beady's private corpus.
      const scope = scopeForRun(ctx, "beady");
      const hits: any[] = [];
      for (const q of queries) hits.push(...(await matchChunks(env, q, scope, 5)));
      const seen = new Set<string>();
      const retrievedEvidence: any[] = [];
      for (const h of hits) {
        const text = h.content || "";
        const key = text.slice(0, 200);
        if (!text || seen.has(key)) continue;
        seen.add(key);
        retrievedEvidence.push({ pageContent: text, source: h.source_name, score: h.similarity ?? null });
        if (retrievedEvidence.length >= 10) break;
      }

      return { opp, docs, company, pp, caps, icp: icpRows[0] ?? null, prompts, retrievedEvidence };
    });

    const base = buildEvaluationPayload({
      opp: context.opp,
      docs: context.docs,
      company: context.company,
      pp: context.pp,
      caps: context.caps,
      retrievedEvidence: context.retrievedEvidence,
    });

    // ── 3. Engine 1: Qualification (9-category) ─────────────────────────────────
    const qualParsed = await step(ctx, "qualification-score", () =>
      scoreQualification(env, base.evaluation_payload, model),
    );
    const scored = computeWeightedScore(qualParsed, base);

    // ── 4. Engine 2: Strategic dimensions D1–D5 ─────────────────────────────────
    const ppRowText = context.pp
      .map((p: any, i: number) => `[Score: ${(0.9 - i * 0.05).toFixed(2)}] ${p.title || ""}\nCustomer: ${p.customer || ""}\nDomain: ${p.domain || ""}\nScope: ${p.scope_summary || ""}`)
      .join("\n---\n");
    const dctx = buildDimensionContext({
      evalPayload: base,
      prompts: context.prompts,
      icp: context.icp,
      ppMatchChunksText: ppRowText,
      rawOpp: context.opp,
    });

    const d1 = await step(ctx, "dimension-d1", () => scoreDimension(env, DIMENSION_SYSTEMS.requirements, dctx.d1_prompt, model));
    const d2 = await step(ctx, "dimension-d2", () => scoreDimension(env, DIMENSION_SYSTEMS.past_performance, dctx.d2_prompt, model));
    const d4 = await step(ctx, "dimension-d4", () => scoreDimension(env, DIMENSION_SYSTEMS.icp_fit, dctx.d4_prompt, model));

    const d3 = await step(ctx, "dimension-d3-incumbent", async () => {
      const queries = buildIncumbentQueries(dctx);
      const snippets: string[] = [];
      const urls: string[] = [];
      const rawResults: any[] = [];
      for (const q of queries) {
        const results = await tavilySearch(env, { query: q.q, includeDomains: q.includeDomains, maxResults: 5 });
        rawResults.push({ source: q.source, results });
        for (const r of results.slice(0, 3)) {
          snippets.push(`[${r.url}] ${r.title}: ${r.content}`);
          if (r.url) urls.push(r.url);
        }
      }
      const { d3_prompt } = buildD3Prompt(dctx, snippets);
      const parsed = await scoreDimension(env, DIMENSION_SYSTEMS.incumbent, d3_prompt, model);

      await sbInsert(env, "incumbent_research", {
        opportunity_id: dctx.opportunity_id,
        incumbent_name: (parsed["incumbent_name"] as string) || "",
        years_on_contract: typeof parsed["years_entrenched"] === "number" ? parsed["years_entrenched"] : null,
        confidence: (parsed["confidence"] as string) || "LOW",
        notes: (parsed["rationale"] as string) || "",
        source_urls: urls,
        raw_search_results: rawResults,
      });
      return parsed;
    });

    const strategic = computeStrategicScores({ d1, d2, d3, d4, ctx: dctx });

    // ── 5. Executive memo + assemble + persist ─────────────────────────────────
    const execMemo = await step(ctx, "executive-memo", () => writeExecutiveMemo(env, scored, model));
    const finalResult = assembleFinalResult(scored, execMemo, strategic);

    const assessment = await step(ctx, "save-assessment", () =>
      sbInsert(env, "assessments", {
        opportunity_id: base.opportunity_id,
        company_profile_id: base.company_profile_id,
        dimension_scores: strategic.strategic_scores,
        weights: strategic.strategic_weights,
        weighted_score: strategic.strategic_weighted_score,
        go_no_go: strategic.go_no_go,
        result: finalResult,
        executive_memo: execMemo,
      }, true),
    );

    return {
      assessmentId: assessment.id,
      opportunityId: String(opportunityId),
      overallScore: Number(scored.overall_score) || 0,
      strategicScore: Number(strategic.strategic_weighted_score) || 0,
      goNoGo: String(strategic.go_no_go || "UNKNOWN"),
      recommendedPosture: String(scored.recommended_posture || "No-bid"),
      executiveMemo: execMemo,
    };
  },
});
