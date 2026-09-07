import { describe, it, expect } from "vitest";
import { assertNotTruncated, LLM_EXTRACT_DEFAULT_MAX_TOKENS } from "../../src/primitives/llm";

/**
 * A truncated extraction used to be indistinguishable from a schema mismatch.
 *
 * When the model hits `max_tokens` mid-answer the tool-use JSON is simply cut off,
 * Zod rejects the malformed input, and the step fails with `{"message":"ZodError"}`.
 * Nothing anywhere says "the answer was too long". Three production runs of
 * beady/opportunity-sweep died that way — 40 notices against a 4096-token cap —
 * and the error pointed at the schema the whole time.
 *
 * `stop_reason` carries the truth and is free to check.
 */
describe("assertNotTruncated", () => {
  it("throws when the model ran out of output room", () => {
    expect(() => assertNotTruncated("max_tokens", "score-all-opportunities", 4096)).toThrow(/output cap/i);
  });

  it("names the call and the cap, so the next person does not debug the schema", () => {
    let msg = "";
    try {
      assertNotTruncated("max_tokens", "score-awards", 8192);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("score-awards");
    expect(msg).toContain("8192");
    expect(msg).toMatch(/not a schema problem/i);
    // It must point at the two real remedies.
    expect(msg).toMatch(/maxTokens/);
    expect(msg).toMatch(/fewer items/i);
  });

  it("passes every stop reason that is not truncation", () => {
    for (const reason of ["end_turn", "tool_use", "stop_sequence", null]) {
      expect(() => assertNotTruncated(reason, "x", 4096)).not.toThrow();
    }
  });

  it("keeps the default cap documented as a named export", () => {
    // Callers returning arrays need to know what they are opting out of.
    expect(LLM_EXTRACT_DEFAULT_MAX_TOKENS).toBe(4096);
  });
});
