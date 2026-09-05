import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The go/no-go assessment must ground itself in the actual solicitation.
 *
 * Run on an existing opportunity with only an `opportunityId`, it used to build its
 * document set purely from optional inputs (a pasted PDF, a summary, notes). With none
 * supplied there was no text, `extractOpportunityFacts` was gated behind that text and
 * never ran, and every extraction field stayed null. The memo said so plainly -- "the
 * opportunity is a black box. Requirements, vehicle, set-aside, FTE range, contract
 * value, evaluation basis, and due date are all unknown" -- while the row held a title,
 * an agency and a 224-character rationale.
 *
 * The capability was never missing: `fetchOpportunityAttachmentText` resolves the notice
 * description and its resourceLinks, and had been wired into beady/rfi-draft alone.
 */

const ROOT = join(__dirname, "../../..");
const ASSESSMENT = join(ROOT, "orchestrations/beady/govcon-assessment/definition.ts");

describe("govcon-assessment grounds itself in the solicitation", () => {
  const src = readFileSync(ASSESSMENT, "utf8");

  it("fetches the solicitation text", () => {
    expect(src).toMatch(/fetchOpportunityAttachmentText\s*\(/);
  });

  it("fetches it from the opportunity's own notice id, not only from an input", () => {
    // The point is that it works with `opportunityId` alone -- the way the workflow and
    // the agent both call it. Keying off sam_notice_id is what makes that possible.
    expect(src).toMatch(/sam_notice_id/);
  });

  it("skips SBIR topics, which have no SAM notice to fetch", () => {
    expect(src).toMatch(/sbir_/);
  });

  it("degrades instead of failing when the fetch does not work", () => {
    // A solicitation we cannot reach should fall back to the metadata-only assessment.
    // The memo already reports its own confidence; "Very Low" beats a failed run.
    const call = src.slice(src.indexOf("fetchOpportunityAttachmentText("));
    expect(call.slice(0, 400)).toMatch(/\.catch\(/);
  });

  it("does not ask the model to rediscover a deadline the row already has", () => {
    // The SSA memo listed the due date as unknown while response_deadline was populated
    // in the same row: the sweep writes response_deadline, the assessment reads due_date.
    expect(src).toMatch(/response_deadline/);
  });
});
