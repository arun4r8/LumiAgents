import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import type { Env } from "@/runtime";
import { MODELS } from "@/runtime/config/models";
import {
  analyzeSolicitation, draftRfiResponse, assessRfiDraft, reviseRfiDraft,
  type RfiAnalysis, type RfiGrounding,
} from "../../../integrations/anthropic/rfi";
import { fetchOpportunityAttachmentText } from "../../../integrations/sam-gov/attachments";

// Hybrid RFI workflow (adapted from the solicitation-response skill):
//
//   analyze -> sufficient?  yes -> draft -> assess -> revise -> ready
//                           no  -> intake gate (stop, ask the human)
//
// The gate is conditional on purpose. Drafting before the facts are confirmed is how
// unconfirmed claims reach a federal submission, so when the analysis finds material
// gaps we stop and collect answers first. When the material is already sufficient we
// don't make a human answer questions for nothing.

export const inputSchema = z.object({
  samNoticeId: z
    .string()
    .describe("sam_notice_id of the opportunity to draft an RFI / Sources Sought response for."),
  answers: z
    .record(z.string())
    .optional()
    .describe("Answers to a previous intake's questions, keyed by question. Supplying these clears the intake gate."),
  draftId: z
    .string()
    .uuid()
    .optional()
    .describe("Existing rfi_drafts row to continue (the one that was waiting at the intake gate)."),
  force: z
    .boolean()
    .optional()
    .describe("Draft even if the analysis finds material gaps. Use sparingly; the gate exists to keep unconfirmed claims out."),
});

export const outputSchema = z.object({
  draftId: z.string().uuid(),
  opportunityTitle: z.string(),
  samNoticeId: z.string(),
  status: z.enum(["intake", "ready"]),
  sufficient: z.boolean(),
  openQuestions: z.number(),
  mustFixApplied: z.number(),
});

// ─── Supabase REST helpers (service role; public schema is the default) ────────

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

// Insert a new draft row, or update the one we're continuing from the intake gate.
async function saveDraft(
  env: Env,
  draftId: string | undefined,
  row: Record<string, unknown>,
): Promise<string> {
  const base = `${env.SUPABASE_URL}/rest/v1/rfi_drafts`;
  const res = draftId
    ? await fetch(`${base}?id=eq.${encodeURIComponent(draftId)}`, {
        method: "PATCH", headers: sbHeaders(env, { Prefer: "return=representation" }), body: JSON.stringify(row),
      })
    : await fetch(base, {
        method: "POST", headers: sbHeaders(env, { Prefer: "return=representation" }), body: JSON.stringify(row),
      });
  if (!res.ok) throw new Error(`Supabase save rfi_drafts → ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as Array<{ id: string }>;
  const id = rows[0]?.id ?? draftId;
  if (!id) throw new Error("rfi_drafts save returned no id");
  return id;
}

const titleOf = (opp: Record<string, unknown>): string =>
  (opp.title as string | null) ?? (opp.opportunity_name as string | null) ?? "Untitled opportunity";

export default defineOrchestration({
  name: "beady/rfi-draft",
  version: 1,
  triggerMode: "agent",
  description:
    "Draft a Sources Sought / RFI response, grounded in Lumiture's profile and past performance. Analyzes the solicitation first: drafts straight through when the material is sufficient, otherwise stops at an intake gate for a human to fill gaps. Drafts are then assessed as an evaluator would and revised.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const env = ctx.env;

    // 1. Load the opportunity.
    const opp = await step(ctx, "load-opportunity", async () => {
      const rows = await sbSelect(env, `opportunities?sam_notice_id=eq.${encodeURIComponent(input.samNoticeId)}&select=*&limit=1`);
      const o = rows[0];
      if (!o) throw new Error(`No opportunity found for sam_notice_id ${input.samNoticeId}`);
      return o;
    });

    // 2. Load Lumiture's profile, past performance, and capability statements.
    const grounded = await step(ctx, "load-grounding", async () => {
      const companies = await sbSelect<{ id: string; profile: unknown }>(env, "company_profiles?select=*&limit=1");
      const company = companies[0];
      const companyId = company?.id;
      const pastPerformance = companyId
        ? await sbSelect(env, `past_performance?company_profile_id=eq.${companyId}&select=*`)
        : [];
      const capabilityStatements = companyId
        ? await sbSelect(env, `capability_statements?company_profile_id=eq.${companyId}&select=*`)
        : [];
      return { companyProfile: company?.profile ?? company ?? {}, pastPerformance, capabilityStatements };
    });

    // 3. Fetch the notice description + attachment text (where the real questions live).
    //    Best-effort: drafting still proceeds without it, and the analysis will notice.
    const attachment = await step(ctx, "fetch-attachment", async () => {
      if (input.samNoticeId.startsWith("sbir_")) return { text: "", note: "skipped (SBIR topic)" };
      return fetchOpportunityAttachmentText(env, input.samNoticeId, (opp.posted_date as string | null) ?? null)
        .catch((e) => ({ text: "", note: `error: ${e instanceof Error ? e.message : String(e)}` }));
    });

    const grounding: RfiGrounding = {
      opportunity: opp,
      companyProfile: grounded.companyProfile,
      pastPerformance: grounded.pastPerformance,
      capabilityStatements: grounded.capabilityStatements,
      attachmentText: attachment.text || null,
    };

    // 4. Phase 1 analyze: what does this solicitation require, and do we know enough?
    const analysis: RfiAnalysis = await step(ctx, "analyze-solicitation", async () =>
      analyzeSolicitation(env, grounding, ctx.model),
    );

    const answers = input.answers ?? null;
    const openMustAnswer = analysis.questions.filter((q) => q.mustAnswer).length;
    // The hybrid decision: gate only when the analysis found material gaps AND the user
    // hasn't already supplied answers (and isn't forcing).
    const gate = !analysis.sufficient && !answers && !input.force;

    // 5a. Gated: store the intake and stop. No draft is written until facts are confirmed.
    if (gate) {
      const draftId = await step(ctx, "store-intake", async () =>
        saveDraft(env, input.draftId, {
          sam_notice_id: input.samNoticeId,
          opportunity_title: titleOf(opp),
          agency: (opp.agency as string | null) ?? null,
          notice_type: (opp.notice_type as string | null) ?? null,
          response_deadline: opp.response_deadline ? String(opp.response_deadline) : null,
          status: "intake",
          analysis,
          intake: {
            sufficiencyReason: analysis.sufficiencyReason,
            questions: analysis.questions,
            matrix: analysis.matrix,
            risks: analysis.risks,
            requiredContent: analysis.requiredContent,
            technicalApproach: analysis.technicalApproach,
          },
          model: ctx.model ?? MODELS.sonnet,
        }),
      );

      return {
        draftId,
        opportunityTitle: titleOf(opp),
        samNoticeId: input.samNoticeId,
        status: "intake" as const,
        sufficient: false,
        openQuestions: analysis.questions.length,
        mustFixApplied: 0,
      };
    }

    // 5b. Phase 4 draft, using the analysis and any confirmed answers.
    const firstDraft = await step(ctx, "draft-response", async () =>
      draftRfiResponse(env, { ...grounding, analysis, answers }, ctx.model),
    );

    // 6. Phase 5 assess as an evaluator would, then revise the must-fixes.
    const assessment = await step(ctx, "assess-draft", async () =>
      assessRfiDraft(env, { draftMarkdown: firstDraft, opportunity: opp, analysis, grounding }, ctx.model),
    );

    const finalDraft = await step(ctx, "revise-draft", async () => {
      if (assessment.mustFix.length === 0) return firstDraft;
      return reviseRfiDraft(env, { draftMarkdown: firstDraft, assessment, grounding }, ctx.model);
    });

    const draftId = await step(ctx, "store-draft", async () =>
      saveDraft(env, input.draftId, {
        sam_notice_id: input.samNoticeId,
        opportunity_title: titleOf(opp),
        agency: (opp.agency as string | null) ?? null,
        notice_type: (opp.notice_type as string | null) ?? null,
        response_deadline: opp.response_deadline ? String(opp.response_deadline) : null,
        draft_markdown: finalDraft,
        status: "ready",
        analysis,
        assessment,
        ...(answers ? { answers } : {}),
        model: ctx.model ?? MODELS.sonnet,
      }),
    );

    return {
      draftId,
      opportunityTitle: titleOf(opp),
      samNoticeId: input.samNoticeId,
      status: "ready" as const,
      sufficient: analysis.sufficient,
      openQuestions: openMustAnswer,
      mustFixApplied: assessment.mustFix.length,
    };
  },
});
