import { describe, it, expect } from "vitest";
import {
  evaluateBidGates,
  isLpta,
  requiresDemo,
  PAST_PERFORMANCE_TARGET,
  type BidGateInputs,
} from "../../../dashboard/lib/bid-gates";
import { parseFactCount } from "../../../integrations/anthropic/govcon";

/**
 * Tommy's bid/no-bid gates (#197). Meeting any ONE puts a deal in our lane:
 *   1. we have 3+ solid past performances
 *   2. they ask for fewer than 3, or require a demo
 *   3. they evaluate LPTA
 *
 * The failure worth guarding against is not a wrong pass; it is a wrong FAIL. Almost
 * no opportunity has been assessed (0 of 277 had these fields at the time of writing),
 * so if missing data read as "not met", every card on the board would say "outside
 * our lane" on no evidence at all, and BD would be steered away from real deals.
 */

const unassessed: BidGateInputs = { evaluation_basis: null, num_past_performances_required: null, extracted_facts: null };
const assessed = (o: Partial<BidGateInputs> & { demo?: string }): BidGateInputs => ({
  evaluation_basis: o.evaluation_basis ?? "Best Value Tradeoff",
  num_past_performances_required: o.num_past_performances_required ?? 3,
  extracted_facts: { requires_demo: o.demo ?? "No" },
});
const TODAY = 2; // public.past_performance rows in production

describe("Option 3: LPTA", () => {
  it.each([
    ["LPTA", true],
    ["Lowest Price Technically Acceptable", true],
    ["lowest-price technically-acceptable source selection", true],
    ["Best Value Tradeoff", false],
    // The extractor offers this as its OWN answer. It is not LPTA, and best value is
    // the evaluation where incumbency counts most -- the opposite of Option 3's point.
    ["Technically Acceptable", false],
  ])("%s -> %s", (basis, expected) => {
    expect(isLpta(basis)).toBe(expected);
  });

  it("treats the extractor's 'Unknown' as unknown, not as 'not LPTA'", () => {
    expect(isLpta("Unknown")).toBeNull();
    expect(isLpta(null)).toBeNull();
  });
});

describe("Option 2: a demo", () => {
  it.each([
    ["Yes", true],
    ["Yes - oral presentation and live demonstration", true],
    ["No", false],
    ["Not required", false],
    ["Unknown", null],
  ])("%s -> %s", (raw, expected) => {
    expect(requiresDemo({ requires_demo: raw })).toBe(expected);
  });

  it("is unknown when the facts are absent", () => {
    expect(requiresDemo(null)).toBeNull();
    expect(requiresDemo({})).toBeNull();
  });
});

describe("evaluateBidGates", () => {
  it("says 'not assessed' rather than 'outside our lane' for an unassessed deal", () => {
    const r = evaluateBidGates(unassessed, TODAY);
    expect(r.status).toBe("unknown");
    expect(r.summary).toMatch(/not assessed/);
    // Option 1 IS known without an assessment: it is about our records, not theirs.
    expect(r.gates.ownPastPerformance).toBe("not_met");
  });

  it("passes on LPTA alone", () => {
    const r = evaluateBidGates(assessed({ evaluation_basis: "LPTA" }), TODAY);
    expect(r.status).toBe("pass");
    expect(r.summary).toMatch(/LPTA/);
  });

  it("passes when they ask for fewer than three past performances", () => {
    const r = evaluateBidGates(assessed({ num_past_performances_required: PAST_PERFORMANCE_TARGET - 1 }), TODAY);
    expect(r.gates.fewPastPerformancesOrDemo).toBe("met");
    expect(r.status).toBe("pass");
  });

  it("does NOT pass when they ask for exactly three -- 'less than 3' is strict", () => {
    const r = evaluateBidGates(assessed({ num_past_performances_required: PAST_PERFORMANCE_TARGET }), TODAY);
    expect(r.gates.fewPastPerformancesOrDemo).toBe("not_met");
  });

  it("passes when they require a demo, however many PPs they ask for", () => {
    const r = evaluateBidGates(assessed({ num_past_performances_required: 5, demo: "Yes" }), TODAY);
    expect(r.gates.fewPastPerformancesOrDemo).toBe("met");
    expect(r.status).toBe("pass");
  });

  it("fails only when every gate is known and none is met", () => {
    const r = evaluateBidGates(assessed({}), TODAY);
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/Outside our lane/);
  });

  it("stays unknown, not fail, when one input is missing and nothing else passes", () => {
    const r = evaluateBidGates(assessed({ demo: "Unknown" }), TODAY);
    expect(r.gates.fewPastPerformancesOrDemo).toBe("unknown");
    expect(r.status).toBe("unknown");
    expect(r.summary).toMatch(/fewer than 3 PPs, or a demo/);
  });

  it("passes Option 1 on our own record count, even on an unassessed deal", () => {
    const r = evaluateBidGates(unassessed, PAST_PERFORMANCE_TARGET);
    expect(r.gates.ownPastPerformance).toBe("met");
    expect(r.status).toBe("pass");
  });

  it("treats an unreadable past-performance count as unknown, never as zero", () => {
    const r = evaluateBidGates(assessed({}), null);
    expect(r.gates.ownPastPerformance).toBe("unknown");
    expect(r.status).toBe("unknown");
  });
});

describe("parseFactCount (the extractor's counts)", () => {
  it.each([
    ["3", 3],
    [" 2 ", 2],
    ["0", 0],
    ["Unknown", null],
    ["", null],
    [null, null],
    // A number inside a sentence is a different requirement, not this count.
    ["3 references", null],
    ["at least 3", null],
    ["no more than 5", null],
  ])("%s -> %s", (raw, expected) => {
    expect(parseFactCount(raw)).toBe(expected);
  });
});
