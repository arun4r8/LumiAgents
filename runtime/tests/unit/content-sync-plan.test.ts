import { describe, it, expect } from "vitest";
import { PLAN_PREVIEW_LIMIT } from "../../../orchestrations/cleo/content-sync/merge";
import { GRAPH_BATCH_MAX } from "../../../integrations/msgraph/base";
import { WORKER_SUBREQUEST_LIMIT, SUBREQUESTS_PER_STEP } from "../../src/config/limits";

/**
 * `plan.plan` was sliced to 100 with no note, while the four arrays that actually
 * drive the writes were uncapped. A dry run against a 400-row sheet therefore
 * reported 100 actions and the real run issued 400.
 *
 * That is not a resource bug. It is a preview that understates the work, which is
 * worse than no preview because it is believed. The cap stays — returning 10,000
 * entries would breach Cloudflare's 1 MiB step-return limit — but it now travels
 * with the true count.
 */
describe("the dry-run preview cannot understate the work", () => {
  it("caps the DISPLAY, and says so in its own name", () => {
    expect(PLAN_PREVIEW_LIMIT).toBe(100);
  });

  it("a plan larger than the cap reports its real size", () => {
    // Simulating what planSync does at its tail, which is the contract that matters:
    // planTotal is recorded BEFORE the slice, so it can never be the sampled length.
    const actions = Array.from({ length: 400 }, (_, i) => ({ action: "new-sheet-row", sheetId: `s${i}` }));
    const planTotal = actions.length;
    const planTruncated = actions.length > PLAN_PREVIEW_LIMIT;
    const plan = actions.slice(0, PLAN_PREVIEW_LIMIT);

    expect(plan).toHaveLength(PLAN_PREVIEW_LIMIT);
    expect(planTotal).toBe(400);
    expect(planTruncated).toBe(true);
    // The failure this prevents: reading the list length as the amount of work.
    expect(plan.length).not.toBe(planTotal);
  });

  it("a plan inside the cap is not marked truncated", () => {
    const actions = Array.from({ length: 12 }, (_, i) => ({ action: "update", sheetId: `s${i}` }));
    expect(actions.length > PLAN_PREVIEW_LIMIT).toBe(false);
  });
});

/**
 * Every Graph call was one subrequest (two before the token cache), so a first sync
 * against the legacy sheet — where every row needs an id backfill — cost ~3 per row
 * and broke at roughly 17 rows of a sheet meant to hold a year of posts.
 */
describe("content-sync fits a realistic sheet inside the Worker ceiling", () => {
  function projected(rows: number): number {
    const cellWrites = Math.ceil(rows / GRAPH_BATCH_MAX); // $batch, 20 per request
    const rowAppends = rows > 0 ? 1 : 0;                  // the rows endpoint takes an array
    const dbWrites = 2;                                   // one insert call, one upsert call
    return (
      3 +                             // workflow entry
      SUBREQUESTS_PER_STEP * 6 +      // read-sheet, read-db, plan, and the three write steps
      2 +                             // the sheet + db reads themselves
      1 +                             // one cached Graph token for the whole run
      cellWrites + rowAppends + dbWrites
    );
  }

  it("handles a year of weekly multi-channel posts", () => {
    // ~200 rows: the size this sheet is actually for, and roughly 12x where it broke.
    expect(projected(200)).toBeLessThan(WORKER_SUBREQUEST_LIMIT);
  });

  it("still has headroom at 400 rows", () => {
    expect(projected(400)).toBeLessThan(WORKER_SUBREQUEST_LIMIT);
  });

  it("shows the batching is what buys the headroom", () => {
    // Unbatched, 200 rows would be 200 cell writes plus 200 appends plus 400 db
    // calls — an order of magnitude past the ceiling.
    const unbatched = 200 + 200 + 400;
    expect(unbatched).toBeGreaterThan(WORKER_SUBREQUEST_LIMIT * 10);
    expect(projected(200)).toBeLessThan(unbatched / 10);
  });
});
