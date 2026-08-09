import { describe, it, expect } from "vitest";
import { findIdentifying, scrub } from "../../../orchestrations/angie/resume-redact/definition";

/**
 * These cover the deterministic half of the blind-resume export (#156).
 *
 * The LLM half cannot be unit tested and, more to the point, cannot be trusted:
 * it will report a clean redaction while leaving a first name in a bullet. The
 * sweep below is what actually decides whether a document is safe to send, so it
 * is the part that needs to be provably correct.
 */

const NAME_LITERALS = ["Jonathan Alvarez", "Jonathan", "Alvarez", "Jon"];

describe("findIdentifying", () => {
  it("returns nothing for a genuinely clean document", () => {
    const text = `PROFESSIONAL SUMMARY
Senior data engineer with nine years building analytics platforms for federal agencies.

EXPERIENCE
Acme Corp, Lead Engineer, 2019 to 2024
- Cut nightly batch time from 6h to 40m across 200 pipelines.`;
    expect(findIdentifying(text, NAME_LITERALS)).toEqual([]);
  });

  it("catches a first name surviving inside a bullet, which is the failure that matters", () => {
    const text = "- Led Jonathan's team through the Census migration.";
    const found = findIdentifying(text, NAME_LITERALS);
    expect(found.some((f) => f.includes("Jonathan"))).toBe(true);
  });

  it("is case insensitive, so a lowercased name does not slip through", () => {
    expect(findIdentifying("contact jonathan for details", NAME_LITERALS).length).toBeGreaterThan(0);
  });

  it("catches emails, phones and personal URLs even when no literal was reported", () => {
    const text = `j.alvarez@example.com | (415) 555-0142 | linkedin.com/in/jalvarez`;
    const found = findIdentifying(text, []);
    expect(found.some((f) => f.startsWith("email"))).toBe(true);
    expect(found.some((f) => f.startsWith("phone"))).toBe(true);
    expect(found.some((f) => f.startsWith("personal URL"))).toBe(true);
  });

  it("catches a phone in a footer regardless of separator style", () => {
    for (const p of ["415-555-0142", "415.555.0142", "+1 415 555 0142", "(415) 555-0142"]) {
      expect(findIdentifying(`References available. ${p}`, []).length).toBeGreaterThan(0);
    }
  });

  it("ignores literals under three characters, which would otherwise match everywhere", () => {
    // A two-letter initial would match inside ordinary words and make every
    // document look dirty, so the sweep skips them by design.
    expect(findIdentifying("Delivered a major platform rebuild.", ["J", "A"])).toEqual([]);
  });

  it("does not flag an employer URL as a personal one", () => {
    expect(findIdentifying("Built the platform at acme.com for the client.", [])).toEqual([]);
  });

  it("treats regex metacharacters in a name as literal text", () => {
    // A name like "O'Brien (Bobby)" must not be compiled as a pattern.
    expect(() => findIdentifying("no match here", ["O'Brien (Bobby)"])).not.toThrow();
    expect(findIdentifying("Report by O'Brien (Bobby) attached", ["O'Brien (Bobby)"]).length).toBe(1);
  });
});

describe("scrub", () => {
  it("removes a name and its possessive form", () => {
    const out = scrub("Led Jonathan's team; Jonathan owned delivery.", NAME_LITERALS);
    expect(out).not.toMatch(/Jonathan/i);
    expect(findIdentifying(out, NAME_LITERALS)).toEqual([]);
  });

  it("removes contact details", () => {
    const out = scrub("Reach me at j.alvarez@example.com or (415) 555-0142", []);
    expect(out).not.toMatch(/@example\.com/);
    expect(out).not.toMatch(/555/);
  });

  it("leaves the substance of the document intact", () => {
    const text = "Cut nightly batch time from 6h to 40m across 200 pipelines at Acme Corp.";
    expect(scrub(text, NAME_LITERALS)).toBe(text);
  });

  it("output of scrub always passes findIdentifying, which is the contract the run() relies on", () => {
    const dirty = `Jonathan Alvarez
j.alvarez@example.com | 415-555-0142 | linkedin.com/in/jalvarez

EXPERIENCE
- Jon led the migration; Alvarez presented results to the client.`;
    expect(findIdentifying(scrub(dirty, NAME_LITERALS), NAME_LITERALS)).toEqual([]);
  });
});
