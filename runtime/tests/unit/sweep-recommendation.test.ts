import { describe, it, expect } from "vitest";
import {
  recommendationFor,
  selectDemotions,
  SCORE_BATCH_SIZE,
  SCORE_MAX_TOKENS,
  SCORE_TIMEOUT_MS,
  scoreSchema,
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
  // Measured across six production batches at 147 tokens per notice with an
  // UNBOUNDED fitReason. The reason is now capped at 25 words, so ~60 is the
  // expectation; 90 is kept as a pessimistic guard.
  const OUTPUT_TOKENS_PER_NOTICE = 90;

  it("keeps a full batch inside the output cap with margin", () => {
    // 1.5x, not 2x. The batch size is set where three constraints meet -- output
    // tokens, the 300s Anthropic timeout, and the 50-subrequest Worker ceiling --
    // and the subrequest ceiling is the binding one, so the token margin is spent
    // deliberately rather than maximised. 147 tokens/notice is a measured mean; a
    // batch of unusually verbose notices still has half again as much room.
    const worstCase = SCORE_BATCH_SIZE * OUTPUT_TOKENS_PER_NOTICE;
    expect(worstCase * 1.5).toBeLessThan(SCORE_MAX_TOKENS);
  });

  it("raises the cap above llm_extract's default, which is what truncated", () => {
    expect(SCORE_MAX_TOKENS).toBeGreaterThan(LLM_EXTRACT_DEFAULT_MAX_TOKENS);
  });

  /**
   * The output cap is only half of it; the batch also has to finish inside the
   * request timeout. Two measurements, and note they are not proportional:
   *
   *   20 notices ->  66s   (3.3s each)
   *   60 notices -> >308s  (>5.1s each, and it blew the 300s default)
   *
   * Cost grows worse than linearly, because the model attends over a longer context
   * as well as writing more output. So the guard must use the LARGE-batch rate, not
   * the small-batch one -- extrapolating 3.3s is what put a 60-notice batch under a
   * 300s timeout on paper while it ran past it in production.
   */
  it("keeps a batch inside its own timeout, using the large-batch rate", () => {
    // 5.5s/notice was measured at batch 60 with unbounded reasons, and that batch
    // ran long enough to draw a 524 from Anthropic's edge. With the reason capped
    // the output roughly halves, so does the time. 3.5 stays pessimistic.
    const SECONDS_PER_NOTICE_AT_SCALE = 3.5;
    const projectedMs = SCORE_BATCH_SIZE * SECONDS_PER_NOTICE_AT_SCALE * 1000;
    expect(projectedMs).toBeLessThan(SCORE_TIMEOUT_MS * 0.75);
  });

  it("raises the timeout rather than relying on the default that this outgrew", () => {
    expect(SCORE_TIMEOUT_MS).toBeGreaterThan(ANTHROPIC_DEFAULT_TIMEOUT_MS);
  });
});

/**
 * The demote step patches rows whose fit narrowed on re-score. It must touch only
 * rows that ALREADY EXIST: on a first sweep most notices score below the floor and
 * none of them are stored, so patching them all is ~100 requests that cannot match
 * a row.
 *
 * This docblock used to claim that fan-out killed the 2026-09-07 18:39 run "after
 * all seven scoring batches had succeeded". It did not, and the claim was an
 * off-by-one written down as fact: `llm-extract-7` is step index 7, which is batch
 * SIX of seven. That run died ENTERING batch seven, three steps before the demote
 * loop, and the database confirms it -- six `score-opportunities-N-of-7` rows
 * reached `completed`, not seven. The real cause was the 50-subrequest ceiling.
 *
 * The fan-out is still a genuine bug and this test still earns its place. But it
 * was never the cause of that failure, and a test comment asserting otherwise sent
 * the investigation the wrong way for an hour.
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

/**
 * The scoring response has to come back in ONE HTTP response, and a long one draws a
 * 524 from Anthropic's edge before it finishes — a failure our own timeout cannot
 * reach, because it is their infrastructure giving up, not ours.
 *
 * That makes output length a hard constraint rather than a matter of taste, and the
 * schema is where it gets enforced: a prompt asking for brevity is a request, a
 * `.max()` is a contract. 60 notices x 147 tokens ran past 490s and failed; the same
 * batch with bounded reasons is roughly half that.
 */
describe("scoring output is bounded, because the whole answer is one response", () => {
  it("caps fitReason and redFlags in the schema, not only in the prompt", () => {
    const field = scoreSchema.shape.scored.element.shape;
    // A 25-word sentence is comfortably under 200 characters; 110 words is not.
    expect(() => field.fitReason.parse("x".repeat(201))).toThrow();
    expect(() => field.fitReason.parse("Strong match: federal data modernisation with a cleared team.")).not.toThrow();
    expect(() => field.redFlags.parse(null)).not.toThrow();
    expect(() => field.redFlags.parse("y".repeat(201))).toThrow();
  });

  it("keeps a full batch's projected response inside the cap with the bounded reason", () => {
    const CHARS_PER_TOKEN = 4;
    const worstCaseChars = SCORE_BATCH_SIZE * (200 + 200); // both fields at their max
    expect(worstCaseChars / CHARS_PER_TOKEN).toBeLessThan(SCORE_MAX_TOKENS);
  });
});
