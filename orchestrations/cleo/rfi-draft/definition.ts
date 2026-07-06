import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import type { Env } from "@/runtime";
import { draftRfiResponse } from "../../../integrations/anthropic/rfi";
import { fetchOpportunityAttachmentText } from "../../../integrations/sam-gov/attachments";

export const inputSchema = z.object({
  samNoticeId: z
    .string()
    .describe("sam_notice_id of the opportunity to draft an RFI / Sources Sought response for."),
});

export const outputSchema = z.object({
  draftId: z.string().uuid(),
  opportunityTitle: z.string(),
  samNoticeId: z.string(),
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

// ─── Orchestration ─────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "cleo/rfi-draft",
  version: 1,
  triggerMode: "agent",
  description:
    "Draft a Sources Sought / RFI response for an opportunity, grounded in Lumiture's profile and past performance. Triggered by Cleo or the dashboard; the draft lands in rfi_drafts.",
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
    const grounding = await step(ctx, "load-grounding", async () => {
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

    // 3. Fetch the notice description + PDF attachment text (the RFI's specific
    //    questions live here). Best-effort — drafting still proceeds without it.
    const attachmentText = await step(ctx, "fetch-attachment", async () => {
      // SBIR ids (sbir_*) aren't SAM notices; only fetch for SAM opportunities.
      if (input.samNoticeId.startsWith("sbir_")) return "";
      return fetchOpportunityAttachmentText(env, input.samNoticeId, (opp.posted_date as string | null) ?? null).catch(() => "");
    });

    // 4. Draft the response.
    const draftMarkdown = await step(ctx, "draft-response", async () => {
      return draftRfiResponse(env, {
        opportunity: opp,
        companyProfile: grounding.companyProfile,
        pastPerformance: grounding.pastPerformance,
        capabilityStatements: grounding.capabilityStatements,
        attachmentText: attachmentText || null,
      }, ctx.model);
    });

    // 5. Store the draft.
    const draftId = await step(ctx, "store-draft", async () => {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rfi_drafts`, {
        method: "POST",
        headers: sbHeaders(env, { Prefer: "return=representation" }),
        body: JSON.stringify({
          sam_notice_id: input.samNoticeId,
          opportunity_title: (opp.title as string | null) ?? (opp.opportunity_name as string | null) ?? "Untitled opportunity",
          agency: (opp.agency as string | null) ?? null,
          notice_type: (opp.notice_type as string | null) ?? null,
          response_deadline: opp.response_deadline ? String(opp.response_deadline) : null,
          draft_markdown: draftMarkdown,
          model: ctx.model ?? "claude-sonnet-4-6",
        }),
      });
      if (!res.ok) throw new Error(`Supabase insert rfi_drafts → ${res.status}: ${await res.text()}`);
      const rows = (await res.json()) as Array<{ id: string }>;
      return rows[0]!.id;
    });

    return {
      draftId,
      opportunityTitle: (opp.title as string | null) ?? (opp.opportunity_name as string | null) ?? "Untitled opportunity",
      samNoticeId: input.samNoticeId,
    };
  },
});
