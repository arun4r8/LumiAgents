import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { listWorkbooksInFolder } from "../../../integrations/msgraph/workbook";
import { resetGraphTokenCache } from "../../../integrations/msgraph/base";
import {
  WORKER_SUBREQUEST_LIMIT,
  SUBREQUESTS_PER_LLM_EXTRACT,
  SUBREQUESTS_PER_STEP,
} from "../../src/config/limits";
import { MAX_ROWS_TO_SCORE, MAX_WORKBOOKS } from "../../../orchestrations/beady/govwin-import/definition";
import { SCORE_BATCH_SIZE } from "../../../orchestrations/beady/opportunity-sweep/definition";

const env = { MSGRAPH_TENANT_ID: "t", MSGRAPH_CLIENT_ID: "c", MSGRAPH_CLIENT_SECRET: "s" };

/**
 * beady/govwin-import addresses BD's exports by FOLDER, because they cannot be
 * addressed any other way: of the three files in "General/2026 Strategy", two carry
 * the export date in the filename, so both the driveItem id and the exact name
 * change every time someone re-exports. That makes the URL this builds the thing
 * the whole import hangs on, and Graph's path addressing has two traps -- the
 * `root:/…:` colons are structural, and segments must be encoded individually or
 * the separators get escaped too.
 */
describe("listWorkbooksInFolder", () => {
  beforeEach(() => resetGraphTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  function stub(graphResponse: Response) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "tok", expires_in: 3599 }), { status: 200 });
        }
        return graphResponse.clone();
      }),
    );
    return calls;
  }

  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const graphCall = (calls: string[]) => calls.find((c) => c.includes("graph.microsoft.com"))!;

  /** The folder as it actually stands on the BD site. */
  const REAL_FOLDER = {
    value: [
      { id: "1", name: "VA.xlsx", webUrl: "https://lumiture.sharepoint.com/sites/BD/Shared%20Documents/General/2026%20Strategy/VA.xlsx", lastModifiedDateTime: "2026-08-26T17:49:07Z" },
      { id: "2", name: "State Local opportunitySearchResults_07-28-2026.xlsx", webUrl: "https://x/2", lastModifiedDateTime: "2026-07-31T19:58:12Z" },
      { id: "3", name: "Upcoming Deals opportunitySearchResults_07-28-2026.xlsx", webUrl: "https://x/3", lastModifiedDateTime: "2026-07-31T20:05:37Z" },
      { id: "4", name: "Forecasts", webUrl: "https://x/4", folder: { childCount: 1 } },
    ],
  };

  it("encodes each path segment but keeps the separators", async () => {
    const calls = stub(ok(REAL_FOLDER));
    await listWorkbooksInFolder(env, { driveId: "b!drive", folderPath: "General/2026 Strategy" });
    // encodeURIComponent on the whole path would give %2F here and Graph would look
    // for one long folder name.
    expect(graphCall(calls)).toContain("/drives/b!drive/root:/General/2026%20Strategy:/children");
    expect(graphCall(calls)).not.toContain("%2F");
  });

  it("strips a leading slash rather than sending an empty first segment", async () => {
    const calls = stub(ok(REAL_FOLDER));
    await listWorkbooksInFolder(env, { driveId: "d", folderPath: "/General/Strategy" });
    expect(graphCall(calls)).toContain("/root:/General/Strategy:/children");
  });

  it("uses the root form when there is no folder path, not an empty path segment", async () => {
    const calls = stub(ok(REAL_FOLDER));
    await listWorkbooksInFolder(env, { driveId: "d", folderPath: "/" });
    // `/root::/children` is not a URL Graph accepts.
    expect(graphCall(calls)).toContain("/drives/d/root/children");
    expect(graphCall(calls)).not.toContain("root::");
  });

  it("returns the three real exports and not the subfolder beside them", async () => {
    stub(ok(REAL_FOLDER));
    const found = await listWorkbooksInFolder(env, { driveId: "d", folderPath: "General/2026 Strategy" });
    expect(found.map((f) => f.name)).toEqual([
      "VA.xlsx",
      "State Local opportunitySearchResults_07-28-2026.xlsx",
      "Upcoming Deals opportunitySearchResults_07-28-2026.xlsx",
    ]);
  });

  it("ignores a FOLDER named like a workbook", async () => {
    // Handing a folder's id to the workbook API is a 400 that reads like a corrupt
    // file, and the filter that prevents it is one property deep.
    stub(ok({ value: [{ id: "f", name: "Archive.xlsx", folder: { childCount: 3 } }] }));
    await expect(listWorkbooksInFolder(env, { driveId: "d", folderPath: "BD" })).resolves.toEqual([]);
  });

  it("ignores Excel's own lock files", async () => {
    // "~$VA.xlsx" appears whenever someone has the real file open, is a genuine
    // driveItem with a genuine .xlsx extension, and is not a workbook.
    stub(ok({ value: [{ id: "1", name: "~$VA.xlsx" }, { id: "2", name: "VA.xlsx" }] }));
    const found = await listWorkbooksInFolder(env, { driveId: "d", folderPath: "BD" });
    expect(found.map((f) => f.name)).toEqual(["VA.xlsx"]);
  });

  it("ignores non-workbooks in the same folder", async () => {
    stub(ok({ value: [{ id: "1", name: "Strategy.docx" }, { id: "2", name: "notes.txt" }, { id: "3", name: "VA.xlsx" }] }));
    const found = await listWorkbooksInFolder(env, { driveId: "d", folderPath: "BD" });
    expect(found.map((f) => f.name)).toEqual(["VA.xlsx"]);
  });

  it("treats a missing folder as empty, rather than throwing", async () => {
    stub(new Response("itemNotFound", { status: 404 }));
    await expect(listWorkbooksInFolder(env, { driveId: "d", folderPath: "BD/gone" })).resolves.toEqual([]);
  });

  it("still throws on a permission failure, which is NOT an empty folder", async () => {
    // The exports live on the BD site, which Sites.Selected may not cover. That has
    // to surface as a failed run, not as the same quiet "nothing to import" as a 404.
    stub(new Response("accessDenied", { status: 403 }));
    await expect(listWorkbooksInFolder(env, { driveId: "d", folderPath: "BD" })).rejects.toThrow(/403/);
  });

  it("does not mistake a 404 inside another error's body for a missing folder", async () => {
    stub(new Response('{"error":{"message":"upstream returned 404 from a sub-service"}}', { status: 500 }));
    await expect(listWorkbooksInFolder(env, { driveId: "d", folderPath: "BD" })).rejects.toThrow(/500/);
  });
});

/**
 * The import shares the sweep's ceiling problem: one Workflow invocation, 50
 * subrequests, spent across every step. It is cheaper than the sweep on I/O and more
 * expensive per row on tokens, so the binding constraints are the number of
 * workbooks opened and the number of scoring batches -- which is why MAX_WORKBOOKS
 * and MAX_ROWS_TO_SCORE exist, and why the NAICS/horizon cut happens before scoring
 * rather than after.
 */
describe("govwin-import subrequest budget", () => {
  function projected(rowsScored: number, workbooks: number): number {
    return (
      3 +                                            // workflow entry
      SUBREQUESTS_PER_STEP + 2 +                     // list-exports: step + token + the listing
      SUBREQUESTS_PER_STEP + workbooks * 2 +         // read-exports: sheet list + used range, each
      1 +                                            // dedupe ledger load
      Math.ceil(rowsScored / SCORE_BATCH_SIZE) * SUBREQUESTS_PER_LLM_EXTRACT +
      (SUBREQUESTS_PER_STEP + 1) * 2                 // record-scored-rows, upsert-opportunities
    );
  }

  it("fits at the maximum work one run will ever take on", () => {
    expect(projected(MAX_ROWS_TO_SCORE, MAX_WORKBOOKS)).toBeLessThan(WORKER_SUBREQUEST_LIMIT);
  });

  it("keeps real headroom there, not one or two spare", () => {
    expect(WORKER_SUBREQUEST_LIMIT - projected(MAX_ROWS_TO_SCORE, MAX_WORKBOOKS)).toBeGreaterThanOrEqual(5);
  });

  it("is bounded by the caps, not by what BD happens to put in the folder", () => {
    // The exports run to thousands of rows between them, in a folder people drop
    // files into. Uncapped, either dimension alone prices the run through the ceiling.
    expect(projected(3_000, 3)).toBeGreaterThan(WORKER_SUBREQUEST_LIMIT);
    expect(projected(MAX_ROWS_TO_SCORE, 40)).toBeGreaterThan(WORKER_SUBREQUEST_LIMIT);
    expect(projected(MAX_ROWS_TO_SCORE, MAX_WORKBOOKS)).toBeLessThan(WORKER_SUBREQUEST_LIMIT);
  });

  it("covers the three exports that are actually there, with room for more", () => {
    expect(MAX_WORKBOOKS).toBeGreaterThanOrEqual(3);
  });
});
