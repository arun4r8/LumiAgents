import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../../runtime/src/types";

// Cleo's RFI / Sources Sought response drafter. Grounds every claim ONLY in the
// provided company profile and past-performance records — never invents contracts,
// certifications, or facts.

const DEFAULT_MODEL = "claude-sonnet-4-6";

function firstText(resp: Anthropic.Message): string {
  const b = resp.content.find((x) => x.type === "text");
  return b && b.type === "text" ? b.text : "";
}

const RFI_SYSTEM = `You are Cleo, Lumiture's proposal-writing assistant. Draft a professional response to a federal Sources Sought / RFI notice on behalf of Lumiture, LLC.

Produce a complete, submission-ready capability statement in Markdown with these sections:
1. Company snapshot (firm name, UEI, CAGE, business size + socioeconomic/set-aside status, NAICS, location, and a point-of-contact line).
2. Statement of interest & understanding of the requirement (show you understand the agency's mission and this specific need).
3. Relevant capabilities (map Lumiture's capabilities to the requirement).
4. Relevant past performance (cite the MOST relevant 2-3 by name, drawn ONLY from the provided records; lead with the closest analog).
5. Business size & set-aside input (state Lumiture's size/socioeconomic status and whether it can perform as a small business — this informs the agency's set-aside decision).
6. Ability to perform & teaming.
7. Brief closing.

Rules:
- Ground EVERY capability and past-performance claim ONLY in the provided company profile and past-performance data. Never invent contracts, dollar values, certifications, clearances, or agencies.
- Where the profile lacks a value (e.g. a point of contact), use a clearly-marked placeholder like [capture POC — name, title, email].
- If the notice poses specific questions and the attachment text is provided, answer them directly; if the attachment is NOT provided, add a note that the final submission will answer the notice's specific questions from the attachment.
- Be concise, confident, and compliant in tone. No marketing fluff, no invented specifics.`;

export interface RfiDraftInput {
  opportunity: Record<string, unknown>;
  companyProfile: unknown;
  pastPerformance: unknown[];
  capabilityStatements: unknown[];
  attachmentText?: string | null;
}

export async function draftRfiResponse(env: Env, input: RfiDraftInput, model = DEFAULT_MODEL): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const payload = {
    opportunity: input.opportunity,
    company_profile: input.companyProfile,
    past_performance: input.pastPerformance,
    capability_statements: input.capabilityStatements,
    attachment_text: input.attachmentText ?? null,
  };
  const resp = await client.messages.create({
    model,
    max_tokens: 3000,
    system: RFI_SYSTEM,
    messages: [{
      role: "user",
      content: `Draft the Sources Sought / RFI response using only this data:\n\n<data>\n${JSON.stringify(payload, null, 2)}\n</data>`,
    }],
  });
  return firstText(resp) || "RFI draft generation failed.";
}
