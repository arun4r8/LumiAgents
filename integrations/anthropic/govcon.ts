import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "./client";
import type { Env } from "../../runtime/src/types";
import { MODELS } from "../../runtime/src/config/models";

// All GovCon assessment LLM calls. Prompts are ported VERBATIM from the n8n
// "GovCon Qualification Assessment" flow so scores stay comparable. The D1–D4
// dimension prompt *bodies* are read live from the prompt_bank table (as n8n did);
// only the system messages (which lived inside n8n nodes) are embedded here.

const DEFAULT_MODEL: string = MODELS.sonnet;

function client(env: Env): Anthropic {
  return anthropicClient(env.ANTHROPIC_API_KEY);
}

function firstText(resp: Anthropic.Message): string {
  const b = resp.content.find((x) => x.type === "text");
  return b && b.type === "text" ? b.text : "";
}

// Lenient JSON extractor, matching the n8n code nodes' parse-or-regex behaviour.
export function parseLooseJson<T = Record<string, unknown>>(raw: string): T {
  const text = String(raw ?? "").trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Model output was not valid JSON");
    return JSON.parse(m[0]) as T;
  }
}

// ─── Information Extractor: Opportunity Facts ──────────────────────────────────

export interface OpportunityFacts {
  agency: string | null;
  vehicle: string | null;
  set_aside: string | null;
  contract_type: string | null;
  pop: string | null;
  due_date: string | null;
  estimated_fte_range: string | null;
  key_requirements: string[];
  evaluation_basis: string | null;
  /** Bid-gate inputs (#197). Nothing asked for these before, so the columns they
   *  land in were never populated on any opportunity. */
  num_past_performances_required: number | null;
  num_key_personnel_required: number | null;
  requires_demo: string | null;
  explicit_unknowns: string[];
}

const EXTRACTOR_ATTRS: Array<{ name: string; description: string }> = [
  { name: "agency", description: "The full agency name, e.g. HHS / NIH / NCATS" },
  { name: "vehicle", description: "Acquisition vehicle name, e.g. CIO-SP3, GSA MAS, SEWP V, or Unknown" },
  { name: "set_aside", description: "Set-aside type, e.g. Small Business, SDVOSB, 8(a), Unrestricted, or Unknown" },
  { name: "contract_type", description: "Contract type, e.g. FFP, T&M, CPFF, IDIQ, BPA, or Unknown" },
  { name: "pop", description: "Period of performance, e.g. 1 base year + 4 option years, or Unknown" },
  { name: "due_date", description: "Proposal or response due date in ISO format YYYY-MM-DD or 'Unknown'" },
  { name: "estimated_fte_range", description: "Estimated full-time equivalent staff range, e.g. 10-20 FTEs, or Unknown" },
  { name: "key_requirements", description: "List of the 5-10 most important technical or programmatic requirements as bullet points" },
  { name: "evaluation_basis", description: "How proposals will be evaluated, e.g. LPTA, Best Value, Technically Acceptable, or Unknown" },
  { name: "num_past_performances_required", description: "How many past performance references the offeror must submit, as a whole number, or Unknown if not stated" },
  { name: "num_key_personnel_required", description: "How many key personnel the offeror must name, as a whole number, or Unknown if not stated" },
  { name: "requires_demo", description: "Whether the evaluation includes a live demonstration, oral presentation or proof of concept: Yes, No, or Unknown" },
  { name: "explicit_unknowns", description: "List any fields that could not be determined from the provided text" },
];

/**
 * A count from the extractor. The tool schema types every scalar as a string, so it
 * arrives as "3" or "Unknown" -- or, from a model being helpful, "3 references" or
 * "at least 3". Only a plain whole number is a count. Everything else is unknown,
 * never a number pulled out of a sentence: "no more than 5" parsed as 5 is a
 * different requirement, and "0 unless requested" parsed as 0 would pass Tommy's
 * Option 2 on a deal that may well ask for five.
 */
export function parseFactCount(v: unknown): number | null {
  const m = /^\s*(\d{1,3})\s*$/.exec(String(v ?? ""));
  return m ? Number(m[1]) : null;
}

export async function extractOpportunityFacts(env: Env, combinedText: string, model = DEFAULT_MODEL): Promise<OpportunityFacts> {
  const properties: Record<string, unknown> = {};
  for (const a of EXTRACTOR_ATTRS) {
    const isList = a.name === "key_requirements" || a.name === "explicit_unknowns";
    properties[a.name] = isList
      ? { type: "array", items: { type: "string" }, description: a.description }
      : { type: "string", description: a.description };
  }
  const resp = await client(env).messages.create({
    model,
    max_tokens: 1500,
    system: "Extract the requested structured fields from the opportunity text. Use 'Unknown' for any field not present.",
    tools: [{ name: "extract_opportunity_facts", description: "Structured GovCon opportunity facts", input_schema: { type: "object", properties, required: EXTRACTOR_ATTRS.map((a) => a.name) } as Anthropic.Tool["input_schema"] }],
    tool_choice: { type: "tool", name: "extract_opportunity_facts" },
    messages: [{ role: "user", content: combinedText }],
  });
  const tu = resp.content.find((b) => b.type === "tool_use");
  if (!tu || tu.type !== "tool_use") throw new Error("Opportunity extractor returned no structured output");
  const o = tu.input as Record<string, unknown>;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

  return {
    agency: str(o["agency"]), vehicle: str(o["vehicle"]), set_aside: str(o["set_aside"]),
    contract_type: str(o["contract_type"]), pop: str(o["pop"]), due_date: str(o["due_date"]),
    estimated_fte_range: str(o["estimated_fte_range"]), evaluation_basis: str(o["evaluation_basis"]),
    num_past_performances_required: parseFactCount(o["num_past_performances_required"]),
    num_key_personnel_required: parseFactCount(o["num_key_personnel_required"]),
    requires_demo: str(o["requires_demo"]),
    key_requirements: arr(o["key_requirements"]), explicit_unknowns: arr(o["explicit_unknowns"]),
  };
}

// ─── Engine 1: Qualification Scoring (9-category 0–5) ──────────────────────────

const QUALIFICATION_SYSTEM = `You are a federal capture qualification analyst.

Use only the evidence provided in the structured payload, including retrieved_evidence. Do not assume facts not in evidence. Be explicit about uncertainty and missing information.

Your job:
1. Assess the opportunity against the company profile and past performance.
2. Score each category from 0 to 5.
3. Recommend one posture: Prime, JV Prime, Subcontractor, or No-bid.
4. Estimate win probability as ranges only.
5. Return valid JSON only.

Scoring rules:
- 0 = blocker
- 1 = very weak
- 2 = weak
- 3 = moderate
- 4 = strong
- 5 = excellent

Rubric:
- technical_fit
- domain_fit
- past_performance_fit
- staffing_feasibility
- compliance_fit
- vehicle_eligibility
- competitive_risk
- teaming_dependency
- strategic_value

Important reasoning rules:
- Do not treat generic capability overlap as enough for a high win probability.
- Penalize for incumbent strength, domain specificity, scale mismatch, weak or indirect past performance, unclear vehicle access, and heavy teaming dependency.
- Reward for clear customer/domain relevance, strong compliance fit, realistic delivery scale, and directly relevant past performance.
- competitive_risk is inverted: low score means high competitive pressure.
- If the opportunity is too large or specialized for solo pursuit, prefer JV Prime or Subcontractor over Prime.
- If evidence is insufficient, say so clearly and lower confidence_level.

Return ONLY this JSON object:
{
  "scores": {
    "technical_fit": {"score": 0, "reason": ""},
    "domain_fit": {"score": 0, "reason": ""},
    "past_performance_fit": {"score": 0, "reason": ""},
    "staffing_feasibility": {"score": 0, "reason": ""},
    "compliance_fit": {"score": 0, "reason": ""},
    "vehicle_eligibility": {"score": 0, "reason": ""},
    "competitive_risk": {"score": 0, "reason": ""},
    "teaming_dependency": {"score": 0, "reason": ""},
    "strategic_value": {"score": 0, "reason": ""}
  },
  "win_probability": {
    "prime_alone": "",
    "jv_prime": "",
    "subcontractor": ""
  },
  "recommended_posture": "",
  "decision": "",
  "top_strengths": [],
  "top_gaps": [],
  "top_risks": [],
  "missing_information": [],
  "next_actions": [],
  "confidence_level": ""
}
`;

export async function scoreQualification(env: Env, evaluationPayload: unknown, model = DEFAULT_MODEL): Promise<Record<string, unknown>> {
  const resp = await client(env).messages.create({
    model, max_tokens: 4096,
    system: QUALIFICATION_SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(evaluationPayload, null, 2) }],
  });
  return parseLooseJson(firstText(resp));
}

// ─── Executive Memo ────────────────────────────────────────────────────────────

const MEMO_SYSTEM = `You are a senior GovCon capture advisor writing a concise executive memo for company leadership.  

Write a plain-English memo of 200-350 words based ONLY on the provided JSON. Do not add information not in the JSON.  

Structure: 
1. One-line recommendation (posture + decision label) 
2. Why: 2-3 key reasons
3. Top 2-3 risks or gaps leadership must know 
4. Confidence caveat if confidence_level is Low or Medium-Low 
5. Immediate next actions (3-5 bullets)  

Tone: Direct. No filler. Written for a BD VP with 90 seconds. Do not use em dashes.`;

export async function writeExecutiveMemo(env: Env, scored: unknown, model = DEFAULT_MODEL): Promise<string> {
  const resp = await client(env).messages.create({
    model, max_tokens: 1024,
    system: MEMO_SYSTEM,
    messages: [{ role: "user", content: `Write the executive memo for this assessment:\n\n${JSON.stringify(scored, null, 2)}` }],
  });
  return firstText(resp) || "Memo generation failed.";
}

// ─── Engine 2: Strategic dimensions (D1–D4, 0.0–1.0) ───────────────────────────

const D1_SYSTEM = `You are a GovCon analyst scoring REQUIREMENTS BURDEN. Respond ONLY with valid JSON: { "score": float, "rationale": string, "flags": [string] }. Score range: 0.0 (very burdensome) to 1.0 (very manageable).`;
const D2_SYSTEM = `You are a GovCon proposal strategist scoring PAST PERFORMANCE LIKENESS. Respond ONLY with valid JSON: { "score": float, "best_matches": [string], "rationale": string, "gaps": [string] }. Score: 0.0 (no match) to 1.0 (perfect match).`;
const D3_SYSTEM = `You are a GovCon competitive intelligence analyst scoring INCUMBENT RISK. Note: the shorter the incumbent has been there, the lower the risk since loyalty is less, but an extremely long time means the incumbent has a high chance of being replaced, so the risk is lower.

Respond ONLY with valid JSON: 
{ "score": float, "incumbent_name": string, "years_entrenched": number, "confidence": "HIGH"|"MEDIUM"|"LOW", "rationale": string }. Score: 0.0 (strong entrenched incumbent = high risk) to 1.0 (no incumbent = low risk).`;
const D4_SYSTEM = `You are a GovCon BD strategist scoring ICP STRATEGIC FIT. Respond ONLY with valid JSON: { "score": float, "fit_factors": [string], "misalignments": [string], "rationale": string }. Score: 0.0 (poor fit) to 1.0 (perfect fit).`;
export const DIMENSION_SYSTEMS = { requirements: D1_SYSTEM, past_performance: D2_SYSTEM, incumbent: D3_SYSTEM, icp_fit: D4_SYSTEM };

// Generic dimension scorer: system message + a prompt_bank-filled user prompt.
export async function scoreDimension(env: Env, system: string, prompt: string, model = DEFAULT_MODEL): Promise<Record<string, unknown>> {
  const resp = await client(env).messages.create({
    model, max_tokens: 1024, system,
    messages: [{ role: "user", content: prompt }],
  });
  try {
    return parseLooseJson(firstText(resp));
  } catch {
    return { score: 0.5, rationale: "Parse error" };
  }
}

// ─── PDF → text (Haiku OCR, mirrors routes/documents.ts ocrWithClaude) ─────────

export async function pdfToText(env: Env, base64: string): Promise<string> {
  const resp = await client(env).messages.create({
    model: MODELS.haiku,
    max_tokens: 8192,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
        { type: "text", text: "Extract all text from this document. Preserve structure (headings, bullet points, tables, numbered lists) as closely as possible. Return only the extracted text with no commentary." },
      ],
    }],
  });
  return firstText(resp);
}
