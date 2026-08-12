import { describe, it, expect } from "vitest";
import { AGENTS, suggestedPromptsFor } from "../../../agents";

/**
 * Every tool a code agent exposes must carry at least one example prompt (#165).
 *
 * The suggestions users see were hand-written into orchestration.agents.card by a
 * migration in early August and never revisited. By the time this test was added
 * the drift was three suggestions against five tools for Angie, six for Beady,
 * six for Cleo. redact_resume, which is the whole point of #156, had none, so the
 * feature was undiscoverable in the surface where 598 conversations happen.
 *
 * Worse than absent: Angie still suggested "Format this resume to our template",
 * which is close enough to a blind-copy request that a user wanting redaction
 * would land on the wrong tool. Coverage is the fix; this test is what keeps it.
 */

describe("tool examples", () => {
  const entries = Object.values(AGENTS).flatMap((a) =>
    a.tools.map((t) => ({ agent: a.slug, tool: t.name, examples: t.examples ?? [] })),
  );

  it("covers every tool on every code agent", () => {
    const missing = entries.filter((e) => e.examples.length === 0).map((e) => `${e.agent}/${e.tool}`);
    expect(missing).toEqual([]);
  });

  it("has tools to check, so a broken import cannot make this pass trivially", () => {
    // Guards the guard: an empty AGENTS would satisfy the assertion above.
    expect(entries.length).toBeGreaterThan(20);
  });

  it("phrases examples as something a person would type, not as a tool name", () => {
    // A bare identifier means someone pasted the tool name in to satisfy the test.
    const identifierish = entries.filter((e) =>
      e.examples.some((x) => /^[a-z][a-z0-9_]*$/.test(x.trim())),
    );
    expect(identifierish.map((e) => `${e.agent}/${e.tool}`)).toEqual([]);
  });

  it("does not repeat the same example across two tools", () => {
    // Two tools sharing a phrase is the ambiguity this is meant to remove.
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const e of entries) {
      for (const x of e.examples) {
        const key = x.trim().toLowerCase();
        const owner = seen.get(key);
        if (owner && owner !== `${e.agent}/${e.tool}`) clashes.push(`${key} (${owner} + ${e.agent}/${e.tool})`);
        else seen.set(key, `${e.agent}/${e.tool}`);
      }
    }
    expect(clashes).toEqual([]);
  });
});

describe("suggestedPromptsFor", () => {
  it("returns prompts for a known agent", () => {
    const out = suggestedPromptsFor("angie");
    expect(out.length).toBeGreaterThan(0);
  });

  it("surfaces the blind resume capability, which had no suggestion at all", () => {
    const out = suggestedPromptsFor("angie").join(" ").toLowerCase();
    expect(out).toContain("blind");
  });

  it("respects the limit and returns nothing for an unknown agent", () => {
    expect(suggestedPromptsFor("angie", 2)).toHaveLength(2);
    expect(suggestedPromptsFor("nope")).toEqual([]);
  });
});
