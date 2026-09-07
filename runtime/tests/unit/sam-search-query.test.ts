import { describe, it, expect } from "vitest";
import {
  buildSamSearchUrl,
  collectSamOpportunities,
  samSearchInputSchema,
  SAM_MAX_PAGES,
  SAM_PAGE_SIZE,
  type SamPageFetcher,
} from "../../../integrations/sam-gov/opportunity-search";

/**
 * The sweep scored 50 of ~8,500 "matching" notices a day, and 77% of what it stored
 * had a response deadline that had already passed. Neither was a sampling policy.
 * The query sent `naicsCode` and `status`, and SAM v2 reads neither: `naicsCode` is
 * not a parameter (the NAICS filter is `ncode`) and `status` is documented "Coming
 * Soon". SAM ignores unknown parameters silently, so both filters read as no filter
 * and the sweep swept the entire corpus, then took whatever 50 came back first.
 *
 * These tests pin the query to parameters SAM actually reads.
 * https://open.gsa.gov/api/get-opportunities-public-api/
 */

const NOW = new Date("2026-09-06T12:00:00Z");

const parse = (o: Record<string, unknown>) => samSearchInputSchema.parse(o);
const paramsOf = (url: string) => new URL(url).searchParams;

describe("buildSamSearchUrl", () => {
  it("filters NAICS with `ncode`, one code per request", () => {
    const p = paramsOf(
      buildSamSearchUrl("k", parse({ naicsCodes: ["541512", "541511"] }), {
        ncode: "541512",
        offset: 0,
        pageSize: SAM_PAGE_SIZE,
        now: NOW,
      }),
    );
    expect(p.get("ncode")).toBe("541512");
    // The regression: a comma list under the wrong name, which SAM drops on the floor.
    expect(p.has("naicsCode")).toBe(false);
    expect(p.get("ncode")).not.toContain(",");
  });

  it("bounds the response deadline instead of asking for `status`", () => {
    const p = paramsOf(buildSamSearchUrl("k", parse({ openOnly: true }), { offset: 0, pageSize: 100, now: NOW }));
    expect(p.get("rdlfrom")).toBe("09/06/2026");
    // SAM caps a two-sided deadline range at one year, so rdlto is inside that.
    expect(p.get("rdlto")).toBe("09/05/2027");
    expect(p.has("status")).toBe(false);
  });

  it("drops the deadline bound when openOnly is off", () => {
    const p = paramsOf(buildSamSearchUrl("k", parse({ openOnly: false }), { offset: 0, pageSize: 100, now: NOW }));
    expect(p.has("rdlfrom")).toBe(false);
    expect(p.has("rdlto")).toBe(false);
  });

  it("sends only parameters SAM v2 documents", () => {
    const documented = new Set([
      "api_key", "ptype", "solnum", "noticeid", "title", "postedFrom", "postedTo",
      "deptname", "subtier", "state", "zip", "organizationCode", "organizationName",
      "typeOfSetAside", "typeOfSetAsideDescription", "ncode", "ccode",
      "rdlfrom", "rdlto", "limit", "offset",
    ]);
    const url = buildSamSearchUrl(
      "k",
      parse({ naicsCodes: ["541512"], keywords: "artificial intelligence", ptypes: ["o", "p", "r"] }),
      { ncode: "541512", offset: 2000, pageSize: SAM_PAGE_SIZE, now: NOW },
    );
    for (const key of paramsOf(url).keys()) {
      expect(documented, `undocumented SAM parameter "${key}" is silently ignored`).toContain(key);
    }
  });

  it("paginates: offset and a full page are always on the query", () => {
    const p = paramsOf(buildSamSearchUrl("k", parse({}), { offset: 3000, pageSize: SAM_PAGE_SIZE, now: NOW }));
    expect(p.get("offset")).toBe("3000");
    expect(p.get("limit")).toBe(String(SAM_PAGE_SIZE));
    expect(SAM_PAGE_SIZE).toBeLessThanOrEqual(1000); // SAM's documented ceiling
  });

  it("windows postedFrom/postedTo by postedWithinDays in SAM's MM/dd/yyyy", () => {
    const p = paramsOf(buildSamSearchUrl("k", parse({ postedWithinDays: 30 }), { offset: 0, pageSize: 100, now: NOW }));
    expect(p.get("postedTo")).toBe("09/06/2026");
    expect(p.get("postedFrom")).toBe("08/07/2026");
  });

  it("searches text with `title`, the only text search v2 supports", () => {
    const p = paramsOf(buildSamSearchUrl("k", parse({ keywords: "data modernization" }), { offset: 0, pageSize: 100, now: NOW }));
    expect(p.get("title")).toBe("data modernization");
    expect(p.has("keywords")).toBe(false);
  });
});

// ─── The walk ──────────────────────────────────────────────────────────────────

/** A fake SAM corpus: `perCode` notices for each NAICS code, served in pages. */
function fakeSam(corpus: Record<string, number>): SamPageFetcher {
  return async ({ ncode, offset, pageSize }) => {
    const key = ncode ?? "(any)";
    const total = corpus[key] ?? 0;
    const rows = [];
    for (let i = offset; i < Math.min(offset + pageSize, total); i++) {
      rows.push({ noticeId: `${key}-${i}`, title: `${key} notice ${i}`, fullParentPathName: "DEPT OF DEFENSE > ARMY" });
    }
    return { totalRecords: total, opportunitiesData: rows };
  };
}

describe("collectSamOpportunities", () => {
  it("splits the limit evenly across NAICS codes instead of draining it into the first", async () => {
    const r = await collectSamOpportunities(
      parse({ naicsCodes: ["A", "B", "C", "D"], limit: 100 }),
      fakeSam({ A: 5000, B: 5000, C: 5000, D: 5000 }),
    );
    // Without a per-code ceiling, code A alone would return all 100 and B/C/D none:
    // the same "whichever came back first" sampling, one level up.
    const byCode = r.opportunities.reduce<Record<string, number>>((acc, o) => {
      const code = o.noticeId.split("-")[0]!;
      acc[code] = (acc[code] ?? 0) + 1;
      return acc;
    }, {});
    expect(byCode).toEqual({ A: 25, B: 25, C: 25, D: 25 });
    expect(r.opportunities).toHaveLength(100);
  });

  it("reports the match set, not the sample, and says when it truncated", async () => {
    const r = await collectSamOpportunities(
      parse({ naicsCodes: ["A", "B"], limit: 10 }),
      fakeSam({ A: 4000, B: 4500 }),
    );
    expect(r.totalRecords).toBe(8500);
    expect(r.matchedByNaics).toEqual({ A: 4000, B: 4500 });
    expect(r.opportunities).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it("is not truncated when it took the whole match set", async () => {
    const r = await collectSamOpportunities(
      parse({ naicsCodes: ["A"], limit: 250 }),
      fakeSam({ A: 12 }),
    );
    expect(r.opportunities).toHaveLength(12);
    expect(r.totalRecords).toBe(12);
    expect(r.truncated).toBe(false);
  });

  it("walks past the first page rather than stopping at one request", async () => {
    // 2,500 wanted from a single code: more than SAM returns in one page.
    const r = await collectSamOpportunities(
      parse({ naicsCodes: ["A"], limit: 1000 }),
      fakeSam({ A: 2500 }),
    );
    expect(r.opportunities).toHaveLength(1000);
    expect(r.requests).toBe(1); // one full 1,000-record page covers the limit
    const offsets = new Set(r.opportunities.map((o) => o.noticeId));
    expect(offsets.size).toBe(1000); // no duplicates
  });

  it("drops a notice SAM repeats, rather than scoring it twice", async () => {
    // SAM's result ordering shifts under a paged walk, so the same notice can come
    // back on more than one page. Here every page serves the same three ids.
    const repeating: SamPageFetcher = async ({ pageSize }) => ({
      totalRecords: 10_000,
      opportunitiesData: Array.from({ length: pageSize }, (_, i) => ({
        noticeId: `n-${i % 3}`,
        title: "t",
      })),
    });
    const r = await collectSamOpportunities(parse({ naicsCodes: ["A"], limit: 60 }), repeating);
    expect(r.opportunities.map((o) => o.noticeId)).toEqual(["n-0", "n-1", "n-2"]);
    expect(r.fetched).toBeGreaterThan(r.opportunities.length);
  });

  it("stops after SAM_MAX_PAGES so a runaway match set cannot walk forever", async () => {
    // Never fills the ceiling (every row is filtered out), so only the page cap stops it.
    const noMatches: SamPageFetcher = async ({ pageSize }) => ({
      totalRecords: 1_000_000,
      opportunitiesData: Array.from({ length: pageSize }, (_, i) => ({
        noticeId: `${Math.random()}-${i}`,
        fullParentPathName: "DEPT OF ENERGY",
      })),
    });
    const r = await collectSamOpportunities(
      parse({ naicsCodes: ["A"], limit: 1000, agencies: ["Department of Defense"] }),
      noMatches,
    );
    expect(r.opportunities).toHaveLength(0);
    expect(r.requests).toBe(SAM_MAX_PAGES);
  });
});

describe("collectSamOpportunities — leftover capacity", () => {
  /**
   * The first live run against the fixed query: 161 matches across four codes,
   * split 91 / 37 / 19 / 14. An equal share of ceil(250/4) = 63 clipped 541330's 91
   * to 63 while the other three left 91 of their share unspent. 133 of 161 pulled,
   * and `truncated` reported true, for no reason but the fairness rule.
   */
  it("takes the whole match set when the limit is big enough, however unevenly it is split", async () => {
    const r = await collectSamOpportunities(
      parse({ naicsCodes: ["541330", "541519", "541512", "541511"], limit: 250 }),
      fakeSam({ "541330": 91, "541519": 37, "541512": 19, "541511": 14 }),
    );
    expect(r.totalRecords).toBe(161);
    expect(r.opportunities).toHaveLength(161);
    expect(r.truncated).toBe(false);
  });

  it("still shares fairly when the limit genuinely binds", async () => {
    const r = await collectSamOpportunities(
      parse({ naicsCodes: ["A", "B"], limit: 40 }),
      fakeSam({ A: 5000, B: 5000 }),
    );
    const byCode = r.opportunities.reduce<Record<string, number>>((acc, o) => {
      const code = o.noticeId.split("-")[0]!;
      acc[code] = (acc[code] ?? 0) + 1;
      return acc;
    }, {});
    // Neither code is starved by the other, even though both could fill the limit.
    expect(byCode).toEqual({ A: 20, B: 20 });
  });

  it("gives a large code the spare share of small ones, not an equal cut", async () => {
    const r = await collectSamOpportunities(
      parse({ naicsCodes: ["big", "small"], limit: 100 }),
      fakeSam({ big: 500, small: 4 }),
    );
    const byCode = r.opportunities.reduce<Record<string, number>>((acc, o) => {
      const code = o.noticeId.split("-")[0]!;
      acc[code] = (acc[code] ?? 0) + 1;
      return acc;
    }, {});
    // Equal shares alone would stop at 50 + 4 = 54 and leave 46 unspent.
    expect(byCode).toEqual({ big: 96, small: 4 });
    expect(r.opportunities).toHaveLength(100);
    // The second pass RESUMES each code's walk. Restarting it from offset 0 would
    // still reach 100 -- the dedupe would hide it -- while re-fetching everything
    // pass 1 already had, spending SAM calls on rows we then throw away.
    expect(r.fetched).toBe(100);
  });

  it("does not loop forever when every code is exhausted below the limit", async () => {
    const r = await collectSamOpportunities(
      parse({ naicsCodes: ["A", "B"], limit: 1000 }),
      fakeSam({ A: 3, B: 2 }),
    );
    expect(r.opportunities).toHaveLength(5);
    expect(r.truncated).toBe(false);
  });
});
