/**
 * Tommy's bid/no-bid gates (#197), from the 2026-09-03 BD syncup:
 *
 *   "We need to only go after deals where we
 *    Option 1: have 3 solid PPs for (we can demonstrate we do this in spades)
 *    Option 2: they ask for less than 3, or require a demo (we can demonstrate live)
 *    Option 3: they evaluate on lowest price technically acceptable"
 *
 * Meeting ANY one gate puts a deal in our lane. The point of evaluating them is the
 * opposite case: a deal that meets none should read as outside our lane, even when
 * its fit score is 9, rather than being left looking attractive.
 *
 * Pure, and three-valued on purpose. Most opportunities have never been assessed, so
 * most inputs are missing, and "we don't know" must not collapse into either "pass"
 * or "fail" -- a gate that reads FAIL because nobody extracted the evaluation basis
 * would steer BD away from deals on no evidence.
 */

/** Option 1's threshold, and Option 2's "less than" in the same unit. */
export const PAST_PERFORMANCE_TARGET = 3;

export type GateStatus = "met" | "not_met" | "unknown";

export interface BidGateInputs {
  evaluation_basis: string | null;
  num_past_performances_required: number | null;
  /** The extractor's raw facts; `requires_demo` is "Yes" | "No" | "Unknown". */
  extracted_facts: Record<string, unknown> | null;
}

export interface BidGateResult {
  /** pass: at least one gate met. fail: every gate known and none met. unknown: otherwise. */
  status: "pass" | "fail" | "unknown";
  gates: { ownPastPerformance: GateStatus; fewPastPerformancesOrDemo: GateStatus; lpta: GateStatus };
  /** One line for a card. */
  summary: string;
}

/**
 * "LPTA" or "lowest price technically acceptable". NOT "technically acceptable"
 * alone and not "best value": the extractor lists "Technically Acceptable" as a
 * separate answer, and a best-value tradeoff is the evaluation where incumbency
 * counts most -- the reverse of what Option 3 is for.
 */
export function isLpta(evaluationBasis: string | null): boolean | null {
  if (!evaluationBasis || /^\s*unknown\s*$/i.test(evaluationBasis)) return null;
  return /\bLPTA\b|lowest[\s-]+price[\s-]+technically[\s-]+acceptable/i.test(evaluationBasis);
}

/** "Yes" / "No" / anything else -> true / false / null. */
export function requiresDemo(facts: Record<string, unknown> | null): boolean | null {
  const raw = facts?.["requires_demo"];
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  if (/^\s*(yes|true|required)\b/i.test(raw)) return true;
  if (/^\s*(no|false|not required)\b/i.test(raw)) return false;
  return null;
}

/**
 * @param ourPastPerformances how many past-performance records Lumiture holds, or
 *   null if that count could not be read. Option 1 is about OUR evidence, not the
 *   solicitation's requirement -- which is why it can be known on a deal nobody has
 *   assessed, and why it is false everywhere until #203 adds the missing records.
 */
export function evaluateBidGates(o: BidGateInputs, ourPastPerformances: number | null): BidGateResult {
  const ownPastPerformance: GateStatus =
    ourPastPerformances === null ? "unknown" : ourPastPerformances >= PAST_PERFORMANCE_TARGET ? "met" : "not_met";

  const asked = o.num_past_performances_required;
  const demo = requiresDemo(o.extracted_facts);
  let fewPastPerformancesOrDemo: GateStatus;
  if ((asked !== null && asked < PAST_PERFORMANCE_TARGET) || demo === true) fewPastPerformancesOrDemo = "met";
  else if (asked === null || demo === null) fewPastPerformancesOrDemo = "unknown";
  else fewPastPerformancesOrDemo = "not_met";

  const l = isLpta(o.evaluation_basis);
  const lpta: GateStatus = l === null ? "unknown" : l ? "met" : "not_met";

  const gates = { ownPastPerformance, fewPastPerformancesOrDemo, lpta };
  const values = Object.values(gates);
  const status = values.includes("met") ? "pass" : values.includes("unknown") ? "unknown" : "fail";

  const LABEL = {
    ownPastPerformance: `${PAST_PERFORMANCE_TARGET}+ of our past performances`,
    fewPastPerformancesOrDemo: `asks for fewer than ${PAST_PERFORMANCE_TARGET} PPs, or a demo`,
    lpta: "evaluated LPTA",
  } as const;
  const keys = Object.keys(gates) as (keyof typeof gates)[];
  const summary =
    status === "pass"
      ? `In our lane: ${keys.filter((k) => gates[k] === "met").map((k) => LABEL[k]).join("; ")}`
      : status === "fail"
        ? "Outside our lane: meets none of the three bid gates"
        : o.evaluation_basis === null && asked === null && demo === null
          ? "Bid gates unknown: not assessed yet"
          : `Bid gates undecided: unknown whether it ${keys.filter((k) => gates[k] === "unknown").map((k) => LABEL[k]).join("; ")}`;

  return { status, gates, summary };
}
