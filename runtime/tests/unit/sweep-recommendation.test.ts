import { describe, it, expect } from "vitest";
import { recommendationFor } from "../../../orchestrations/beady/opportunity-sweep/definition";

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
