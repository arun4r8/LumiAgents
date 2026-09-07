import { describe, it, expect } from "vitest";
import {
  recommendationFor,
  selectDemotions,
  SCORE_BATCH_SIZE,
  SCORE_MAX_TOKENS,
} from "../../../orchestrations/beady/opportunity-sweep/definition";
import { LLM_EXTRACT_DEFAULT_MAX_TOKENS } from "../../src/primitives/llm";
import { ANTHROPIC_DEFAULT_TIMEOUT_MS } from "../../../integrations/anthropic/client";

/**
 * `recommendation` was asked of the model alongside `fit_score`, under a prompt rule
 * that defined it AS the score: pursue >= 7, monitor 5-6, pass <= 4. Every row in
 * production obeyed that rule, so the column carried nothing the score did not, while
 * presenting itself on the card as a second, independent judgement (#206).
 *
 * Deriving it says the same thing honestly. These tests pin the bands, and pin the
 * fact that no score can produce a recommendation the score does not imply -- which
 * asking a model for it could always do.
 */

describe("recommendationFor", () => {
  it("maps the bands the prompt used to describe", () => {
    expect([1, 2, 3, 4].map(recommendationFor)).toEqual(["pass", "pass", "pass", "pass"]);
    expect([5, 6].map(recommendationFor)).toEqual(["monitor", "monitor"]);
    expect([7, 8, 9, 10].map(recommendationFor)).toEqual(["pursue", "pursue", "pursue", "pursue"]);
  });

  it("puts the pursue boundary at 7 and the pass boundary at 5", () => {
    expect(recommendationFor(6)).toBe("monitor");
    expect(recommendationFor(7)).toBe("pursue");
    expect(recommendationFor(4)).toBe("pass");
    expect(recommendationFor(5)).toBe("monitor");
  });

  it("is total over the score range, so no notice can end up unlabelled", () => {
    for (let n = 1; n <= 10; n++) {
      expect(["pursue", "monitor", "pass"]).toContain(recommendationFor(n));
    }
  });
});

/**
 * The scoring batch is sized against llm_extract's output cap, not against taste.
 * On the first live run a 40-notice batch at the default 4096 tokens truncated
 * mid-array after five minutes and surfaced as a bare `ZodError` -- a truncated
 * tool-use response is not reported as truncation anywhere.
 *
 * The relationship these pin: each scored notice costs roughly 80 output tokens
 * (id, integer, a sentence of reason, a nullable flag), so the batch must fit
 * inside the cap with real headroom.
 */
describe("scoring batch sizing", () => {
  const BYTES_PER_SCORED_NOTICE = 80;

  it("keeps a full batch well inside the output cap", () => {
    const worstCase = SCORE_BATCH_SIZE * BYTES_PER_SCORED_NOTICE;
    expect(worstCase).toBeLessThan(SCORE_MAX_TOKENS / 2);
  });

  it("raises the cap above llm_extract's default, which is what truncated", () => {
    expect(SCORE_MAX_TOKENS).toBeGreaterThan(LLM_EXTRACT_DEFAULT_MAX_TOKENS);
  });

  /**
   * The output cap is only half of it. The same 40-notice batch also spent 316
   * seconds before failing, against a 300s Anthropic timeout (#193) -- so even with
   * room to answer, a batch that size is racing the clock. The observed cost was
   * ~8s per notice, so the batch has to fit the timeout with margin.
   */
  it("keeps a batch inside the Anthropic timeout, not just inside the token cap", () => {
    const OBSERVED_SECONDS_PER_NOTICE = 8;
    const projectedMs = SCORE_BATCH_SIZE * OBSERVED_SECONDS_PER_NOTICE * 1000;
    expect(projectedMs).toBeLessThan(ANTHROPIC_DEFAULT_TIMEOUT_MS * 0.75);
  });
});

/**
 * The demote step patches rows whose fit narrowed on re-score. It must touch only
 * rows that ALREADY EXIST: on a first sweep most notices score below the floor and
 * none of them are stored, so patching them all is ~100 requests that cannot match
 * a row. That is what killed the 2026-09-07 18:39 run — Cloudflare's per-invocation
 * subrequest limit, hit after all seven scoring batches had succeeded.
 */
describe("selectDemotions", () => {
  const subFloor = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("demotes only notices that are already stored", () => {
    expect(selectDemotions(subFloor, new Set(["b", "d"]))).toEqual([{ id: "b" }, { id: "d" }]);
  });

  it("does nothing on a sweep where nothing sub-floor was ever stored", () => {
    expect(selectDemotions(subFloor, new Set())).toEqual([]);
  });

  it("ignores stored rows that did not score below the floor", () => {
    // The stored set is the intersection lookup's answer, not the whole table, but
    // a superset must not widen what gets patched.
    expect(selectDemotions([{ id: "a" }], new Set(["a", "zzz"]))).toEqual([{ id: "a" }]);
  });
});
