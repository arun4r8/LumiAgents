import { describe, it, expect } from "vitest";
import { PDF_REQUIRED_TOOLS, PDF_BATCH_TOOLS, PDF_FIELD_BY_TOOL } from "../../src/utils/pdf";
import { buildUserContent } from "../../src/primitives/llm";

/**
 * Covers the PDF path added for #166.
 *
 * The behaviour that actually needs defending is the one nobody would notice
 * breaking: `llm_extract` is called by every orchestration in the registry, so
 * adding documents to it must leave the no-document request byte-identical. A
 * one-element content array would "work" and would also silently change every
 * LLM call in the product.
 *
 * This file used to re-implement buildUserContent locally and assert against the
 * copy, on the grounds that the real one was not exported. That is not a test: a
 * mirror and its original can only ever agree with each other, so the assertions
 * held no matter what the primitive did. It is the same failure that let fakeSam
 * hide a paging bug through a full mutation-tested suite (#222).
 *
 * The function is exported now and this tests the real one.
 */

describe("llm_extract user content", () => {
  it("returns a bare string when there are no documents, not a content array", () => {
    // The regression that would go unnoticed: every existing orchestration call.
    expect(buildUserContent("do the thing")).toBe("do the thing");
    expect(buildUserContent("do the thing", [])).toBe("do the thing");
    expect(buildUserContent("do the thing", undefined)).toBe("do the thing");
  });

  it("puts documents before the instruction so the prompt reads as being about them", () => {
    const out = buildUserContent("redact this", [
      { base64: "QUJD", mediaType: "application/pdf" },
    ]) as { type: string }[];
    expect(Array.isArray(out)).toBe(true);
    expect(out.map((b) => b.type)).toEqual(["document", "text"]);
  });

  it("emits the document block shape the Anthropic API expects", () => {
    const [doc] = buildUserContent("x", [
      { base64: "QUJD", mediaType: "application/pdf" },
    ]) as { type: string; source: { type: string; media_type: string; data: string } }[];
    expect(doc).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "QUJD" },
    });
  });

  it("carries several documents in order", () => {
    const out = buildUserContent("x", [
      { base64: "AAA", mediaType: "application/pdf" },
      { base64: "BBB", mediaType: "application/pdf" },
    ]) as { type: string; source?: { data: string } }[];
    expect(out.map((b) => b.type)).toEqual(["document", "document", "text"]);
    expect(out[0]!.source!.data).toBe("AAA");
    expect(out[1]!.source!.data).toBe("BBB");
  });
});

describe("PDF dispatch wiring", () => {
  it("routes redact_resume's PDF, which is the bug in #166", () => {
    expect(PDF_REQUIRED_TOOLS.has("redact_resume")).toBe(true);
    expect(PDF_FIELD_BY_TOOL.redact_resume).toBe("resume_pdf_base64");
  });

  it("every single-PDF tool declares the field it wants the bytes in", () => {
    // Before this, non-batch tools all received `solicitationPdfBase64` whether or
    // not they declared it. A tool in the set with no field is now a hard error at
    // dispatch rather than a payload the orchestration silently ignores.
    const singles = [...PDF_REQUIRED_TOOLS].filter((t) => !PDF_BATCH_TOOLS.has(t));
    const missing = singles.filter((t) => !PDF_FIELD_BY_TOOL[t]);
    expect(missing).toEqual([]);
  });

  it("keeps assess_opportunity on its original field", () => {
    expect(PDF_FIELD_BY_TOOL.assess_opportunity).toBe("solicitationPdfBase64");
  });

  it("does not give the batch tool a single-file field", () => {
    expect(PDF_BATCH_TOOLS.has("score_resumes")).toBe(true);
    expect(PDF_FIELD_BY_TOOL.score_resumes).toBeUndefined();
  });
});
