import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetGraphTokenCache } from "../../../integrations/msgraph/base";
import {
  ensureProjectFolder,
  projectFolderName,
  sanitiseFolderName,
  PROJECT_SUBFOLDERS,
  OPPORTUNITY_ROOT,
} from "../../../integrations/msgraph/folders";

/**
 * Folder names come from SAM: solicitation numbers are tame, titles are free text
 * and routinely contain characters SharePoint rejects outright. A rejected name is
 * a 400 in the middle of creating a tree, leaving a half-built folder behind.
 */
describe("sanitiseFolderName", () => {
  it("strips the characters SharePoint refuses", () => {
    // " * : < > ? / \ | are all illegal in a driveItem name.
    expect(sanitiseFolderName('RFI: "Cloud" <Data>/Analytics * ?')).toBe("RFI Cloud Data Analytics");
  });

  it("removes leading and trailing dots and spaces, which SharePoint also refuses", () => {
    expect(sanitiseFolderName("  .Enterprise AI Strategy.  ")).toBe("Enterprise AI Strategy");
  });

  it("truncates rather than letting a long SAM title fail the call", () => {
    const long = "A".repeat(300);
    expect(sanitiseFolderName(long).length).toBeLessThanOrEqual(90);
  });

  it("never returns an empty name", () => {
    // A title of only illegal characters would otherwise produce "", and creating a
    // folder named "" fails in a way that reads as a permissions problem.
    expect(sanitiseFolderName("///")).toBe("untitled");
    expect(sanitiseFolderName("   ")).toBe("untitled");
  });
});

describe("projectFolderName", () => {
  it("leads with the solicitation number, which is the stable half", () => {
    expect(
      projectFolderName({ solicitationNumber: "W91QF026QA015", title: "CIO Microsoft Sentinel Implementation FY26" }),
    ).toBe("W91QF026QA015 - CIO Microsoft Sentinel Implementation FY26");
  });

  it("copes with a notice that has no solicitation number", () => {
    // Sources Sought notices frequently have none.
    expect(projectFolderName({ solicitationNumber: null, title: "Enterprise AI Strategy" })).toBe("Enterprise AI Strategy");
  });

  it("copes with neither, rather than creating a folder called 'null'", () => {
    expect(projectFolderName({})).toBe("untitled opportunity");
  });

  it("is stable for the same opportunity, so re-Pursue does not make a second folder", () => {
    const opp = { solicitationNumber: "36C10B25Q0123", title: "Data Modernisation Support" };
    expect(projectFolderName(opp)).toBe(projectFolderName(opp));
  });
});

describe("the layout matches the Figma", () => {
  it("creates exactly the three subfolders the design specifies", () => {
    expect([...PROJECT_SUBFOLDERS]).toEqual(["NOTES", "SOLICITATION", "RESPONSE"]);
  });

  it("roots under General/Opportunity Tracking, beside the existing folders", () => {
    // Not at the drive root: 'Project Agent BeaDy' and 'Data Files' already live
    // there and this must not disturb them.
    expect(OPPORTUNITY_ROOT).toBe("General/Opportunity Tracking");
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

/**
 * "Idempotent" is the ticket's explicit requirement, and the whole of it lives in
 * one Graph field. `conflictBehavior: "fail"` makes a second create return 409, which
 * we then resolve to the existing folder. With "rename" — the alternative that also
 * looks correct — a re-Pursue silently produces "NOTES 1" beside "NOTES", and the
 * first anyone knows is a document filed in a folder nobody opens.
 */
describe("ensureProjectFolder is idempotent", () => {
  function fakeGraph(existing: Set<string>) {
    const calls: { method: string; url: string; name?: string }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3599 }), { status: 200 });
      }
      if (method === "POST") {
        const name = JSON.parse(String(init?.body ?? "{}")).name as string;
        calls.push({ method, url: u, name });
        if (existing.has(name)) {
          return new Response(JSON.stringify({ error: { code: "nameAlreadyExists" } }), { status: 409 });
        }
        existing.add(name);
        return new Response(JSON.stringify({ id: `id-${name}`, name, webUrl: `https://sp/${name}` }), { status: 201 });
      }
      calls.push({ method, url: u });
      const name = decodeURIComponent(u.split("root:/")[1] ?? "").split("/").pop() ?? "x";
      return new Response(JSON.stringify({ id: `id-${name}`, name, webUrl: `https://sp/${name}` }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  const env = { MSGRAPH_TENANT_ID: "t", MSGRAPH_CLIENT_ID: "c", MSGRAPH_CLIENT_SECRET: "s" };
  const opp = { solicitationNumber: "W91QF026QA015", title: "Sentinel Implementation" };

  beforeEach(() => resetGraphTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  it("creates the tree once", async () => {
    fakeGraph(new Set());
    const r = await ensureProjectFolder(env, "drive1", opp);
    expect(r.created).toHaveLength(4); // project + 3 subfolders
    expect(r.folderId).toContain("W91QF026QA015");
  });

  it("re-running creates nothing new and returns the same folder", async () => {
    const existing = new Set<string>();
    fakeGraph(existing);
    const first = await ensureProjectFolder(env, "drive1", opp);

    resetGraphTokenCache();
    const calls = fakeGraph(existing); // same corpus: everything already exists
    const second = await ensureProjectFolder(env, "drive1", opp);

    expect(second.folderId).toBe(first.folderId);
    // Every POST on the second run must have been rejected as a conflict, and no
    // folder gained a "1" suffix.
    expect(calls.filter((c) => c.method === "POST").every((c) => existing.has(c.name!))).toBe(true);
    expect([...existing].some((n) => /\s1$/.test(n))).toBe(false);
  });
});
