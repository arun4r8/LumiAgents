import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../../runtime/src/types";

// Beady's Sources Sought / RFI response workflow: analyze the solicitation, decide
// whether we know enough to draft, draft, then assess the draft as an evaluator would
// and revise. Every claim is grounded ONLY in the provided company profile and
// past-performance records; we never invent contracts, certifications, or facts.
//
// The discipline here is accuracy: a federal submission that overstates experience or
// asserts unconfirmed facts is a real liability, so the workflow is built to prevent it.

const DEFAULT_MODEL = "claude-sonnet-4-6";

function firstText(resp: Anthropic.Message): string {
  const b = resp.content.find((x) => x.type === "text");
  return b && b.type === "text" ? b.text : "";
}

// LLM JSON isn't always bare, so pull the first balanced object out of the response.
function parseJson<T>(text: string, fallback: T): T {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : text) as T;
  } catch {
    return fallback;
  }
}

async function ask(env: Env, model: string, system: string, user: string, maxTokens: number): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  return firstText(resp);
}

// ─── Shared types ──────────────────────────────────────────────────────────────

export interface RfiGrounding {
  opportunity: Record<string, unknown>;
  companyProfile: unknown;
  pastPerformance: unknown[];
  capabilityStatements: unknown[];
  attachmentText?: string | null;
}

export interface RfiAnalysis {
  requiredContent: Array<{ item: string; note: string }>;
  risks: Array<{ kind: string; detail: string }>;
  sufficient: boolean;
  sufficiencyReason: string;
  questions: Array<{ question: string; why: string; mustAnswer: boolean }>;
  matrix: Array<{ engagement: string; requirement: string; strength: "Strong" | "Partial" | "Indirect" | "None"; how: string }>;
  technicalApproach: {
    required: boolean;
    sufficiencyGaps: string[];
    depthQuestions: string[];
    bestPractices: Array<{ item: string; status: string; kind: "gap" | "enhancement" }>;
  } | null;
}

export interface RfiAssessment {
  compliance: Array<{ item: string; pass: boolean; note: string }>;
  factors: Array<{ factor: string; rating: "strong" | "adequate" | "weak"; weakness: string }>;
  accuracy: Array<{ issue: string; severity: "must-fix" | "note" }>;
  mustFix: string[];
  wouldStrengthen: string[];
}

// ─── Phase 1: analyze the solicitation ─────────────────────────────────────────

const ANALYZE_SYSTEM = `You are Beady, Lumiture's GovCon analyst. Analyze a federal solicitation (RFI, Sources Sought, RFP, RFQ) and decide whether there is enough confirmed information on hand to draft an accurate response.

The solicitation dictates the response. Derive exactly what THIS solicitation asks for, in the structure it asks for, and nothing more. Do not carry sections over out of habit. Only include past performance, intent to bid, technical approach, personnel, or company facts if the solicitation actually asks for them.

Judge fit strictly. Do not inflate a loose analogue into a strong match.

Flag these high-risk items when present:
- Deadline (with time zone) and whether it is near.
- Page or format limits.
- Entity and attribution: work delivered by personnel in prior roles at other employers must be phrased "our personnel, in prior roles, served as..." and never "our company performed...". Flag this whenever past performance is requested.
- Mandatory facts the user must supply and that must never be guessed: contract vehicles, GSA schedule numbers, SAM UEI, CAGE, business size and socioeconomic status, clearance ability.
- Hedged or unconfirmed claims in the reference material ("probably", "I think"), which cannot appear in a federal submission.

Then judge SUFFICIENCY: is there enough confirmed information to draft a response that is accurate and addresses every required item, without inventing or hedging? Set "sufficient" false if any mandatory fact the solicitation requires is missing, if a required item has no supporting material, or if drafting would force an unconfirmed claim. Set it true only when the response can be written entirely from confirmed material (placeholders for minor items such as a point of contact are acceptable).

Every question you raise must be answerable by the user and must matter to the response. Mark the ones that block an accurate draft as mustAnswer.

If the solicitation asks for a technical approach or solution, also assess it: which requirements are fully described versus missing, what depth would make it compelling (discriminators, quantified outcomes, risk handling, transition, security, scalability, staffing, explicit assumptions), and how it compares to relevant best practices. Mark best-practice items as a "gap" to fix or an optional "enhancement". Best-practice content is where confident-but-wrong output happens most, so propose it for human review rather than asserting specifics from memory.

Return ONLY a JSON object:
{
  "requiredContent": [{"item": "...", "note": "what the solicitation says about it"}],
  "risks": [{"kind": "deadline|page-limit|attribution|mandatory-fact|hedged-claim", "detail": "..."}],
  "sufficient": true or false,
  "sufficiencyReason": "one or two sentences",
  "questions": [{"question": "...", "why": "...", "mustAnswer": true or false}],
  "matrix": [{"engagement": "...", "requirement": "...", "strength": "Strong|Partial|Indirect|None", "how": "short phrase on how it fits"}],
  "technicalApproach": null or {"required": true, "sufficiencyGaps": ["..."], "depthQuestions": ["..."], "bestPractices": [{"item": "...", "status": "meets|partial|misses", "kind": "gap|enhancement"}]}
}
Fill the matrix yourself from the reference material; never hand back an empty grid when past performance is requested.`;

export async function analyzeSolicitation(env: Env, input: RfiGrounding, model = DEFAULT_MODEL): Promise<RfiAnalysis> {
  const payload = {
    opportunity: input.opportunity,
    solicitation_text: input.attachmentText ?? null,
    company_profile: input.companyProfile,
    past_performance: input.pastPerformance,
    capability_statements: input.capabilityStatements,
  };
  const text = await ask(env, model, ANALYZE_SYSTEM,
    `Analyze this solicitation using only this data:\n\n<data>\n${JSON.stringify(payload, null, 2)}\n</data>`, 4000);
  return parseJson<RfiAnalysis>(text, {
    requiredContent: [], risks: [], sufficient: false,
    sufficiencyReason: "The analysis could not be parsed, so this is treated as insufficient and routed to a human before drafting.",
    questions: [], matrix: [], technicalApproach: null,
  });
}

// ─── Phase 4: draft ────────────────────────────────────────────────────────────

const RFI_SYSTEM = `You are Beady, Lumiture's proposal writer. Draft a response to a federal Sources Sought / RFI notice on behalf of Lumiture, LLC.

The solicitation dictates the response. Respond to exactly what it asks for, in the order and structure it uses, addressing every required item from the supplied required-content list. Do not add sections it did not ask for.

Rules:
- Ground EVERY capability and past-performance claim ONLY in the provided company profile, past-performance data, and the user's confirmed intake answers. Never invent contracts, dollar values, certifications, clearances, or agencies.
- Attribute past performance correctly. Work delivered by Lumiture's people while at a former employer is "our personnel, in prior roles, served as...", never "our company performed...".
- No hedging. If something was never confirmed, leave it out or phrase it as capability rather than past performance.
- Where a required value is genuinely missing, use a clearly marked placeholder such as [capture POC name, title, email] rather than guessing.
- Respect any page or format limit as a hard constraint.
- If the notice poses specific questions and the solicitation text is provided, answer them directly.
- For a technical approach, build on the confirmed material and the user's accepted enhancements only. Make assumptions explicit. Do not silently add capabilities the user did not confirm.
- Be concise, confident, and compliant. No marketing fluff.

Output submission-ready Markdown.`;

export interface RfiDraftInput extends RfiGrounding {
  analysis?: RfiAnalysis | null;
  answers?: Record<string, string> | null;
}

export async function draftRfiResponse(env: Env, input: RfiDraftInput, model = DEFAULT_MODEL): Promise<string> {
  const payload = {
    opportunity: input.opportunity,
    solicitation_text: input.attachmentText ?? null,
    company_profile: input.companyProfile,
    past_performance: input.pastPerformance,
    capability_statements: input.capabilityStatements,
    required_content: input.analysis?.requiredContent ?? null,
    risk_flags: input.analysis?.risks ?? null,
    experience_fit_matrix: input.analysis?.matrix ?? null,
    technical_approach_analysis: input.analysis?.technicalApproach ?? null,
    confirmed_answers: input.answers ?? null,
  };
  const text = await ask(env, model, RFI_SYSTEM,
    `Draft the response using only this data:\n\n<data>\n${JSON.stringify(payload, null, 2)}\n</data>`, 4000);
  return text || "RFI draft generation failed.";
}

// ─── Phase 5: assess (adversarial) then revise ─────────────────────────────────

const ASSESS_SYSTEM = `You are a federal source-selection evaluator scoring a draft response. You did not write it and you have no stake in it. Your job is to find reasons to mark it down while they are still fixable.

Be harsh. This is otherwise a self-review, and the natural bias is to be too kind. When in doubt, call something a weakness and let the human decide it is acceptable.

Run these checks in order, because the earlier ones are more disqualifying:

1. COMPLIANCE (disqualifying). Walk the required-content list item by item. Is each required section, question, and evaluation factor addressed, in the required structure, within any page or format limit? A non-compliant response can be eliminated before its content is judged.
2. EVALUATION FACTORS. For each stated factor, or if none are stated each thing the solicitation clearly cares about, rate strong/adequate/weak and name the specific reason it is not higher. Look for factors addressed generically rather than with creditable specifics, claims without substantiation, requirements answered in narrative but not tied to the scoring factor, and discriminators that are buried or missing.
3. SOLUTION SOUNDNESS (only if a technical approach is included). Is it technically credible, internally consistent, and mapped to every requirement? Flag hand-waving, filler, and buzzwords standing in for substance.
4. ACCURACY SWEEP (the guardrail that matters most). Hunt for any claim not traceable to the supplied confirmed material, past performance attributed to the company when it was delivered by personnel in prior roles elsewhere, residual hedging ("probably", "likely", "should") in factual claims, and specific numbers, control identifiers, framework versions, or standard names asserted from memory. Every accuracy problem is a must-fix. Overstatement on a federal submission is a liability, not a stylistic nit.

Split fixes into mustFix (compliance and accuracy) and wouldStrengthen (competitiveness).

Return ONLY a JSON object:
{
  "compliance": [{"item": "...", "pass": true or false, "note": "..."}],
  "factors": [{"factor": "...", "rating": "strong|adequate|weak", "weakness": "..."}],
  "accuracy": [{"issue": "...", "severity": "must-fix|note"}],
  "mustFix": ["..."],
  "wouldStrengthen": ["..."]
}`;

export async function assessRfiDraft(
  env: Env,
  input: { draftMarkdown: string; opportunity: Record<string, unknown>; analysis: RfiAnalysis | null; grounding: RfiGrounding },
  model = DEFAULT_MODEL,
): Promise<RfiAssessment> {
  const payload = {
    opportunity: input.opportunity,
    required_content: input.analysis?.requiredContent ?? null,
    solicitation_text: input.grounding.attachmentText ?? null,
    confirmed_material: {
      company_profile: input.grounding.companyProfile,
      past_performance: input.grounding.pastPerformance,
      capability_statements: input.grounding.capabilityStatements,
    },
    draft: input.draftMarkdown,
  };
  const text = await ask(env, model, ASSESS_SYSTEM,
    `Score this draft:\n\n<data>\n${JSON.stringify(payload, null, 2)}\n</data>`, 3000);
  return parseJson<RfiAssessment>(text, { compliance: [], factors: [], accuracy: [], mustFix: [], wouldStrengthen: [] });
}

const REVISE_SYSTEM = `You are Beady, revising a federal response draft to address an evaluator's must-fix findings.

Apply every must-fix directly. Compliance gaps get the missing content, drawn only from the confirmed material. Accuracy problems get corrected or removed: downgrade overstated claims, fix past-performance attribution, delete hedging, and strip any specific you cannot trace to the confirmed material.

Do NOT invent new facts to close a gap. If a must-fix can only be resolved with information the user has not provided, leave a clearly marked placeholder instead of fabricating.

Leave everything else intact. Return the complete revised Markdown response and nothing else.`;

export async function reviseRfiDraft(
  env: Env,
  input: { draftMarkdown: string; assessment: RfiAssessment; grounding: RfiGrounding },
  model = DEFAULT_MODEL,
): Promise<string> {
  const payload = {
    must_fix: input.assessment.mustFix,
    accuracy_issues: input.assessment.accuracy.filter((a) => a.severity === "must-fix"),
    failed_compliance: input.assessment.compliance.filter((c) => !c.pass),
    confirmed_material: {
      company_profile: input.grounding.companyProfile,
      past_performance: input.grounding.pastPerformance,
      capability_statements: input.grounding.capabilityStatements,
    },
    draft: input.draftMarkdown,
  };
  const text = await ask(env, model, REVISE_SYSTEM,
    `Revise the draft:\n\n<data>\n${JSON.stringify(payload, null, 2)}\n</data>`, 4000);
  return text || input.draftMarkdown;
}
