// Deterministic scoring + payload/prompt assembly for the GovCon assessment.
// Ported VERBATIM from the n8n flow's Code nodes (no LLM here). Pure functions:
// the orchestration does all I/O and feeds these the DB rows + LLM outputs.

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

// ─── Build Evaluation Payload (n8n Code node "Build Evaluation Payload") ───────

export function buildEvaluationPayload(args: {
  opp: Row;
  docs: Row[];
  company: Row;
  pp: Row[];
  caps: Row[];
  retrievedEvidence: any[];
}): { opportunity_id: any; company_profile_id: any; evaluation_payload: Row } {
  const { opp, docs, company, pp, caps, retrievedEvidence } = args;
  if (!opp) throw new Error("Opportunity not found");
  if (!company?.id && !company?.profile) throw new Error("Company profile not found");

  const missingFields: string[] = [];
  if (!opp.vehicle || opp.vehicle === "Unknown") missingFields.push("vehicle");
  if (!opp.set_aside || opp.set_aside === "Unknown") missingFields.push("set_aside");
  if (!opp.estimated_fte_range || opp.estimated_fte_range === "Unknown") missingFields.push("estimated_fte_range");
  if (!opp.due_date || opp.due_date === "Unknown") missingFields.push("due_date");
  if (!opp.evaluation_basis || opp.evaluation_basis === "Unknown") missingFields.push("evaluation_basis");

  const explicitUnknowns = Array.isArray(opp.extracted_facts?.explicit_unknowns)
    ? opp.extracted_facts.explicit_unknowns
    : [];
  const allMissing = [...new Set([...missingFields, ...explicitUnknowns])];

  const payload = {
    opportunity_id: opp.id,
    company_profile_id: company.id || null,
    opportunity: {
      opportunity_name: opp.opportunity_name || "Unknown",
      agency: opp.agency || "Unknown",
      vehicle: opp.vehicle || "Unknown",
      set_aside: opp.set_aside || "Unknown",
      contract_type: opp.contract_type || "Unknown",
      pop: opp.pop || "Unknown",
      due_date: opp.due_date || "Unknown",
      estimated_fte_range: opp.estimated_fte_range || "Unknown",
      key_requirements: Array.isArray(opp.key_requirements) ? opp.key_requirements : [],
      evaluation_basis: opp.evaluation_basis || "Unknown",
    },
    company_profile: company.profile || company,
    past_performance: pp.map((p) => ({
      title: p.title || "",
      customer: p.customer || "",
      domain: p.domain || "",
      scope_summary: p.scope_summary || "",
      contract_value: p.contract_value || "",
      period_of_performance: p.period_of_performance || "",
      relevance_tags: Array.isArray(p.relevance_tags) ? p.relevance_tags : [],
    })),
    capability_statements: caps.map((c) => ({
      capability_name: c.capability_name || "",
      description: c.description || "",
    })),
    source_documents: docs.map((d) => ({
      doc_type: d.doc_type || "",
      raw_text: (d.raw_text || "").slice(0, 4000),
    })),
    retrieved_evidence: retrievedEvidence,
    missing_information_known_at_intake: allMissing,
  };

  return {
    opportunity_id: payload.opportunity_id,
    company_profile_id: payload.company_profile_id,
    evaluation_payload: payload,
  };
}

// ─── Engine 1 deterministic (n8n: "Compute Weighted Score + Decision Logic") ───

const WEIGHTS: Record<string, number> = {
  technical_fit: 20,
  domain_fit: 15,
  past_performance_fit: 15,
  staffing_feasibility: 15,
  compliance_fit: 10,
  vehicle_eligibility: 5,
  competitive_risk: 10,
  teaming_dependency: 5,
  strategic_value: 5,
};

export function computeWeightedScore(scored: Row, base: Row): Row {
  const scoreKeys = Object.keys(WEIGHTS);
  if (!scored.scores || typeof scored.scores !== "object") scored.scores = {};

  for (const key of scoreKeys) {
    if (!scored.scores[key]) scored.scores[key] = { score: 0, reason: "No score returned." };
    if (typeof scored.scores[key].score !== "number") scored.scores[key].score = Number(scored.scores[key].score) || 0;
    if (scored.scores[key].score < 0) scored.scores[key].score = 0;
    if (scored.scores[key].score > 5) scored.scores[key].score = 5;
    if (!scored.scores[key].reason) scored.scores[key].reason = "";
    scored.scores[key].weight = WEIGHTS[key];
  }

  let total = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    total += (scored.scores[key].score / 5) * weight;
  }
  scored.overall_score = Math.round(total);

  if (!scored.win_probability || typeof scored.win_probability !== "object") scored.win_probability = {};
  scored.win_probability.prime_alone = scored.win_probability.prime_alone || "";
  scored.win_probability.jv_prime = scored.win_probability.jv_prime || "";
  scored.win_probability.subcontractor = scored.win_probability.subcontractor || "";

  if (!Array.isArray(scored.top_strengths)) scored.top_strengths = [];
  if (!Array.isArray(scored.top_gaps)) scored.top_gaps = [];
  if (!Array.isArray(scored.top_risks)) scored.top_risks = [];
  if (!Array.isArray(scored.missing_information)) scored.missing_information = [];
  if (!Array.isArray(scored.next_actions)) scored.next_actions = [];

  const intakeMissing = base.evaluation_payload?.missing_information_known_at_intake || [];
  scored.missing_information = [...new Set([...scored.missing_information, ...intakeMissing])];

  const vehicleScore = scored.scores.vehicle_eligibility.score;
  const competitiveScore = scored.scores.competitive_risk.score;
  const ppScore = scored.scores.past_performance_fit.score;
  const staffScore = scored.scores.staffing_feasibility.score;
  const techScore = scored.scores.technical_fit.score;
  const domainScore = scored.scores.domain_fit.score;

  let recommendedPosture = scored.recommended_posture || "No-bid";
  const overrideNotes: string[] = [];

  if (vehicleScore <= 1) {
    recommendedPosture = "No-bid";
    overrideNotes.push("Vehicle or eligibility blocker.");
  } else if (scored.overall_score < 50) {
    recommendedPosture = "No-bid";
    overrideNotes.push("Overall score below 50.");
  } else if (scored.overall_score < 65) {
    if (!["JV Prime", "Subcontractor"].includes(recommendedPosture)) recommendedPosture = "Subcontractor";
    overrideNotes.push("Score in 50-64 band favors Subcontractor or selective JV posture.");
  } else if (scored.overall_score < 80) {
    if (ppScore <= 2 || staffScore <= 2) {
      recommendedPosture = "JV Prime";
      overrideNotes.push("Conditional pursue band with weak past performance or staffing depth.");
    }
    if (competitiveScore <= 1 && recommendedPosture === "Prime") {
      recommendedPosture = "JV Prime";
      overrideNotes.push("High competitive pressure caps solo Prime posture.");
    }
  } else {
    if (ppScore <= 2 || domainScore <= 2) {
      recommendedPosture = "JV Prime";
      overrideNotes.push("High score offset by weak domain or past performance relevance.");
    }
  }

  if (techScore <= 2 && domainScore <= 2 && ppScore <= 2 && recommendedPosture === "Prime") {
    recommendedPosture = "Subcontractor";
    overrideNotes.push("Core fit is too weak for a credible Prime recommendation.");
  }

  const validPostures = ["Prime", "JV Prime", "Subcontractor", "No-bid"];
  if (!validPostures.includes(recommendedPosture)) {
    recommendedPosture = "No-bid";
    overrideNotes.push("Invalid posture normalized to No-bid.");
  }

  scored.recommended_posture = recommendedPosture;
  scored.decision_override_note = overrideNotes.join(" ");

  const oppMeta = base.evaluation_payload?.opportunity || {};
  scored.opportunity_id = base.opportunity_id;
  scored.company_profile_id = base.company_profile_id;
  scored.opportunity_name = oppMeta.opportunity_name || "Unknown";
  scored.agency = oppMeta.agency || "Unknown";
  scored.vehicle = oppMeta.vehicle || "Unknown";
  scored.set_aside = oppMeta.set_aside || "Unknown";
  scored.contract_type = oppMeta.contract_type || "Unknown";
  scored.pop = oppMeta.pop || "Unknown";
  scored.due_date = oppMeta.due_date || "Unknown";
  scored.estimated_fte_range = oppMeta.estimated_fte_range || "Unknown";
  scored.key_requirements = oppMeta.key_requirements || [];
  scored.evaluation_basis = oppMeta.evaluation_basis || "Unknown";
  scored.scored_at = new Date().toISOString();

  return scored;
}

// ─── Dimension prompt assembly (n8n Code node "Build Dimension Context") ───────

function fillTemplate(template: string | undefined, vars: Record<string, any>): string {
  if (!template) return "";
  let t = template;
  for (const [k, v] of Object.entries(vars)) {
    t = t.replace(new RegExp("\\{\\{" + k + "\\}\\}", "g"), String(v));
  }
  return t;
}

export interface DimensionContext {
  opportunity_id: any;
  company_profile_id: any;
  d1_prompt: string;
  d2_prompt: string;
  d3_prompt_template: string;
  d4_prompt: string;
  d5_context: { set_aside: any; vehicle: any; socioeconomic_status: any };
  agency: string;
  opp_name: string;
}

export function buildDimensionContext(args: {
  evalPayload: Row;
  prompts: Row[];
  icp: Row | null;
  ppMatchChunksText: string;
  rawOpp: Row;
}): DimensionContext {
  const { evalPayload, prompts, icp, ppMatchChunksText, rawOpp } = args;
  const promptMap: Record<string, string> = {};
  for (const p of prompts) promptMap[p.dimension] = p.prompt_template;

  const opp = evalPayload.evaluation_payload?.opportunity || {};

  const pageCount = rawOpp.page_count || null;
  const dueDate = rawOpp.due_date || opp.due_date;
  const numPP = rawOpp.num_past_performances_required || null;
  const numKP = rawOpp.num_key_personnel_required || null;
  const pagesPerDay = pageCount && dueDate
    ? pageCount / Math.max(1, Math.ceil((new Date(dueDate).getTime() - Date.now()) / 86400000))
    : null;

  return {
    opportunity_id: evalPayload.opportunity_id,
    company_profile_id: evalPayload.company_profile_id,
    d1_prompt: fillTemplate(promptMap["requirements"], {
      pages_per_day_ratio: pagesPerDay ? pagesPerDay.toFixed(2) : "unknown",
      num_past_performances: numPP || "unknown",
      num_key_personnel: numKP || "unknown",
    }),
    d2_prompt: fillTemplate(promptMap["past_performance"], {
      rfp_scope: (opp.key_requirements || []).join("; "),
      past_performance_chunks: ppMatchChunksText,
    }),
    d3_prompt_template: promptMap["incumbent"] || "",
    d4_prompt: fillTemplate(promptMap["icp_fit"], {
      icp_profile: JSON.stringify(icp || {}),
      agency: opp.agency || "Unknown",
      set_aside: opp.set_aside || "Unknown",
      vehicle: opp.vehicle || "Unknown",
      domain: (opp.key_requirements || []).slice(0, 2).join(", ") || "Unknown",
      contract_value: opp.estimated_fte_range || "Unknown",
      pop: opp.pop || "Unknown",
    }),
    d5_context: {
      set_aside: opp.set_aside,
      vehicle: opp.vehicle,
      socioeconomic_status: evalPayload.evaluation_payload?.company_profile?.socioeconomic_status || [],
    },
    agency: opp.agency || "",
    opp_name: opp.opportunity_name || "",
  };
}

// ─── Incumbent research (n8n: "Build Incumbent Queries" + "Aggregate …") ───────

export function buildIncumbentQueries(ctx: DimensionContext): Array<{ q: string; source: string; includeDomains: string[] }> {
  const agency = ctx.agency || "";
  const oppName = ctx.opp_name || "";
  return [
    { source: "usaspending", q: `"${agency}" "${oppName}" incumbent contractor site:usaspending.gov`, includeDomains: ["usaspending.gov"] },
    { source: "fpds", q: `"${agency}" "${oppName}" awarded contract site:fpds.gov`, includeDomains: ["fpds.gov"] },
    { source: "sam", q: `"${agency}" "${oppName}" contract award incumbent site:sam.gov`, includeDomains: ["sam.gov"] },
  ];
}

export function buildD3Prompt(ctx: DimensionContext, snippets: string[]): { d3_prompt: string; incumbent_findings: string } {
  const incumbent_findings = snippets.length > 0
    ? snippets.join("\n")
    : "No search results found. Insufficient data to determine incumbent.";
  const d3_prompt = ctx.d3_prompt_template
    ? ctx.d3_prompt_template
        .replace("{{agency}}", ctx.agency)
        .replace("{{opportunity_name}}", ctx.opp_name)
        .replace("{{incumbent_findings}}", incumbent_findings)
    : `Agency: ${ctx.agency}\nOpportunity: ${ctx.opp_name}\nFindings:\n${incumbent_findings}`;
  return { d3_prompt, incumbent_findings };
}

// ─── Engine 2 deterministic (n8n Code node "Compute Strategic Scores") ─────────

export function computeStrategicScores(args: {
  d1: Row; d2: Row; d3: Row; d4: Row; ctx: DimensionContext;
}): Row {
  const { d1, d2, d3, d4, ctx } = args;
  const d5ctx: any = ctx.d5_context || {};

  const num = (v: any, fallback = 0.5): number => (typeof v === "number" ? v : fallback);
  const incumbentRisk = num(d3.score);
  const icpFit = num(d4.score);
  const hasSetAside = ["SB", "SDVOSB", "8(a)", "HUBZone"].includes(d5ctx.set_aside || "");
  const hasVehicle = Boolean(d5ctx.vehicle && d5ctx.vehicle !== "Unknown");
  const d5Score = Math.min(1.0, incumbentRisk * 0.4 + icpFit * 0.3 + (hasSetAside ? 0.2 : 0.0) + (hasVehicle ? 0.1 : 0.0));

  const W = { d2: 0.30, d4: 0.25, d1: 0.20, d3: 0.15, d5: 0.10 };
  const d1s = num(d1.score), d2s = num(d2.score), d3s = num(d3.score), d4s = num(d4.score);
  const weightedScore = d1s * W.d1 + d2s * W.d2 + d3s * W.d3 + d4s * W.d4 + d5Score * W.d5;
  const go_no_go = weightedScore >= 0.7 ? "GO" : weightedScore >= 0.5 ? "CONDITIONAL" : "NO GO";

  return {
    strategic_scores: {
      d1_requirements: { score: d1s, detail: d1 },
      d2_pp_likeness: { score: d2s, detail: d2 },
      d3_incumbent: { score: d3s, detail: d3 },
      d4_icp_fit: { score: d4s, detail: d4 },
      d5_competitive: { score: d5Score, rationale: "Computed from D3+D4+set_aside+vehicle" },
    },
    strategic_weights: W,
    strategic_weighted_score: Math.round(weightedScore * 100),
    go_no_go,
    opportunity_id: ctx.opportunity_id,
    company_profile_id: ctx.company_profile_id,
  };
}

// ─── Assemble Final Result (n8n Code node "Assemble Final Result") ─────────────

export function assembleFinalResult(scored: Row, execMemo: string, strategic: Row): Row {
  return {
    ...scored,
    executive_memo: execMemo,
    strategic_scores: strategic.strategic_scores || {},
    strategic_weighted_score: strategic.strategic_weighted_score ?? null,
    go_no_go: strategic.go_no_go || "UNKNOWN",
    dimension_weights: strategic.strategic_weights || {},
  };
}
