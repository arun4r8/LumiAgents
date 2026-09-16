import { describe, it, expect } from "vitest";

/**
 * beady/govcon-assessment fetches solicitation text from SAM by sam_notice_id. That
 * column is the GENERIC external id: a raw SAM notice id, `sbir_<topic>`, or
 * `govwin_<Opp ID>`. Only the first resolves in SAM. The guard skipped `sbir_` and
 * nothing else, so every GovWin opportunity spent a SAM request against the shared
 * daily quota to be told "notice not found" -- which reads like a missing
 * solicitation rather than a source that was never SAM's.
 */
const isSamNoticeId = (id: string) => !/^(sbir|govwin)_/.test(id);

describe("which ids belong in a SAM lookup", () => {
  it.each([
    ["fa0630b52e8643468f1c7d0cba7ba961", true],
    ["f7959c3af28546af984971eb89471761", true],
    ["govwin_256570", false],
    ["govwin_13301489", false],
    ["sbir_AF241-0001", false],
  ])("%s -> %s", (id, expected) => {
    expect(isSamNoticeId(id)).toBe(expected);
  });

  it("matches the guard the assessment actually uses", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../../orchestrations/beady/govcon-assessment/definition.ts", import.meta.url),
      "utf8",
    );
    // The guard must exclude both prefixes; naming only one is the bug.
    expect(src).toMatch(/\/\^\(sbir\|govwin\)_\/\.test\(noticeId\)/);
  });
});
