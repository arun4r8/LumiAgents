import { describe, it, expect } from "vitest";
import {
  WORKER_SUBREQUEST_LIMIT,
  SUBREQUESTS_PER_LLM_EXTRACT,
  SUBREQUESTS_PER_STEP,
  SUBREQUESTS_PER_TOOL_CALL,
} from "../../src/config/limits";
import { SCORE_BATCH_SIZE, SBIR_SOURCE_AVAILABLE } from "../../../orchestrations/beady/opportunity-sweep/definition";
import { SAM_PAGE_SIZE } from "../../../integrations/sam-gov/opportunity-search";

/**
 * beady/opportunity-sweep died three times against an invisible constraint.
 *
 * Cloudflare allows 50 subrequests per Worker invocation, and a Workflow spends that
 * budget across the whole orchestration. Nothing in the code said so, nothing
 * counted, and the failure ("Too many subrequests by single Worker invocation")
 * names no culprit. It was found by tracing every outbound fetch by hand.
 *
 * The trap is that the obvious lever pushes the wrong way. Scoring 133 notices in
 * SMALLER batches feels safer -- less to truncate, more headroom on the timeout --
 * but each batch is an llm_extract costing 3 subrequests, so going from 40 to 20
 * per batch took scoring from 12 subrequests to 21 and pushed the run past the wall.
 * It died entering the last batch, having scored 133 notices it then discarded.
 *
 * This test makes the budget explicit. It is arithmetic, not a mock: if someone
 * halves the batch size again, or adds a per-item request, CI says so.
 */
describe("opportunity-sweep subrequest budget", () => {
  // The largest match set we design for: samLimit's default.
  const NOTICES = 250;

  function projectedSubrequests(noticesPulled: number, batchSize: number): number {
    const samPages = Math.ceil(noticesPulled / SAM_PAGE_SIZE) + 4; // + one probe per NAICS code
    return (
      3 +                                                   // workflow entry: getRun + resolveOrchestrationModel
      SUBREQUESTS_PER_TOOL_CALL +                           // SAM.gov defineTool
      1 +                                                   // ONE budget claim for the whole paged walk
      samPages +                                            // the page GETs themselves
      (SBIR_SOURCE_AVAILABLE ? SUBREQUESTS_PER_TOOL_CALL + 2 : 0) + // SBIR, when the source exists
      1 +                                                   // dedupe ledger load
      SUBREQUESTS_PER_STEP * 2 +                            // fetch-both-sources, sweep-health-alert
      Math.ceil(noticesPulled / batchSize) * SUBREQUESTS_PER_LLM_EXTRACT +
      (SUBREQUESTS_PER_STEP + 1) * 2 +                      // record-scored-notices, upsert-opportunities
      (SUBREQUESTS_PER_STEP + 1)                            // demote: one lookup, then rare patches
    );
  }

  it("a full sweep fits inside the Worker subrequest ceiling", () => {
    expect(projectedSubrequests(NOTICES, SCORE_BATCH_SIZE)).toBeLessThan(WORKER_SUBREQUEST_LIMIT);
  });

  it("keeps real headroom, not one or two spare", () => {
    // A sweep that fits with nothing to spare fails the first time SAM returns an
    // extra page or a retry fires.
    const used = projectedSubrequests(NOTICES, SCORE_BATCH_SIZE);
    expect(WORKER_SUBREQUEST_LIMIT - used).toBeGreaterThanOrEqual(5);
  });

  it("shows that smaller batches cost MORE, which is the counterintuitive part", () => {
    const at60 = projectedSubrequests(133, SCORE_BATCH_SIZE);
    const at20 = projectedSubrequests(133, 20);
    // Each batch is one llm_extract. Thirds the batch, triples that cost.
    expect(at20).toBeGreaterThan(at60);
    expect(at20 - at60).toBeGreaterThanOrEqual(SUBREQUESTS_PER_LLM_EXTRACT * 2);
  });

  it("reproduces theconfiguration that actually died", () => {
    // The 2026-09-07 run: batch 20, SBIR still being called, budget claimed per
    // page. It died entering batch 7 at subrequest 51 of 50.
    const perPageClaims = Math.ceil(133 / SAM_PAGE_SIZE) + 4;
    const asItWas =
      projectedSubrequests(133, 20) +
      (SUBREQUESTS_PER_TOOL_CALL + 2) + // SBIR, which was still being called
      perPageClaims;                    // budget claimed per page, not once
    expect(asItWas).toBeGreaterThan(WORKER_SUBREQUEST_LIMIT);
  });
});
