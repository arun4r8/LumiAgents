import { describe, it, expect } from "vitest";
import {
  buildBdAnalytics,
  groupBy,
  isLive,
  mean,
  STRONG_FIT,
  type AnalyticsRow,
} from "../../../dashboard/lib/bd-analytics";

/**
 * These numbers are the ones a person will act on — which agency to chase, whether
 * a NAICS code earns its place. A wrong bar chart is not obviously wrong; it looks
 * like data. So the aggregation is a pure module rather than logic inside a page.
 */

const NOW = new Date("2026-09-08T12:00:00Z").getTime();
const row = (o: Partial<AnalyticsRow>): AnalyticsRow => ({
  agency: "DEPT OF DEFENSE",
  naics_code: "541512",
  fit_score: 5,
  disposition: null,
  response_deadline: "2026-10-01T00:00:00Z",
  notice_text_fetched_at: null,
  ...o,
});

describe("isLive", () => {
  it("counts a future deadline", () => {
    expect(isLive(row({ response_deadline: "2026-10-01T00:00:00Z" }), NOW)).toBe(true);
  });

  it("does not count a passed deadline", () => {
    expect(isLive(row({ response_deadline: "2026-08-01T00:00:00Z" }), NOW)).toBe(false);
  });

  it("does not count an UNKNOWN deadline as live", () => {
    // Unknown is not open. Counting nulls as actionable overstates the pipeline,
    // and 119 of the first 155 rows stored had already-passed deadlines — this is
    // not a hypothetical distinction.
    expect(isLive(row({ response_deadline: null }), NOW)).toBe(false);
  });
});

describe("groupBy", () => {
  const rows = [
    row({ agency: "DEPT OF DEFENSE", fit_score: 8 }),
    row({ agency: "DEPT OF DEFENSE", fit_score: 4, response_deadline: "2026-01-01T00:00:00Z" }),
    row({ agency: "VETERANS AFFAIRS, DEPARTMENT OF", fit_score: 7 }),
  ];

  it("ranks by volume and reports the strong-fit share within each", () => {
    const out = groupBy(rows, (r) => r.agency, NOW);
    expect(out[0]!.label).toBe("DEPT OF DEFENSE");
    expect(out[0]!.total).toBe(2);
    expect(out[0]!.strong).toBe(1); // the 8; the 4 is not strong
    expect(out[0]!.live).toBe(1); // the other deadline has passed
    expect(out[0]!.avgFit).toBe(6); // (8 + 4) / 2
  });

  it("skips a null key rather than inventing an 'unknown' bucket", () => {
    // A row with no NAICS says nothing about NAICS performance, and a bucket
    // labelled "unknown" invites someone to read it as a code.
    const out = groupBy([...rows, row({ naics_code: null })], (r) => r.naics_code, NOW);
    expect(out.every((b) => b.label !== "unknown" && b.label !== "null")).toBe(true);
    expect(out.reduce((n, b) => n + b.total, 0)).toBe(3);
  });

  it("does not let an unscored row drag a bucket's average down", () => {
    // Per-bucket average, not just the headline one. An unscored opportunity is not
    // a zero-fit opportunity, and treating it as one makes an agency look worse the
    // more of its notices are waiting to be scored.
    const out = groupBy(
      [row({ agency: "NASA", fit_score: 8 }), row({ agency: "NASA", fit_score: null })],
      (r) => r.agency,
      NOW,
    );
    expect(out[0]!.avgFit).toBe(8);
    expect(out[0]!.total).toBe(2); // still counted as an opportunity
  });

  it("breaks volume ties by label, so the order is stable between renders", () => {
    const out = groupBy(
      [row({ agency: "B AGENCY" }), row({ agency: "A AGENCY" })],
      (r) => r.agency,
      NOW,
    );
    expect(out.map((b) => b.label)).toEqual(["A AGENCY", "B AGENCY"]);
  });
});

describe("buildBdAnalytics", () => {
  it("separates 'has a score' from 'has been read'", () => {
    // The distinction the page leads with: a fit score computed from a title is a
    // different kind of number from one computed from the notice, and nothing on an
    // opportunity card distinguishes them.
    const out = buildBdAnalytics(
      [
        row({ notice_text_fetched_at: "2026-09-08T08:20:00Z" }),
        row({ notice_text_fetched_at: null }),
        row({ notice_text_fetched_at: null }),
      ],
      NOW,
    );
    expect(out.total).toBe(3);
    expect(out.bodyScored).toBe(1);
    expect(out.total - out.bodyScored).toBe(2);
  });

  it("gives every score 1-10 a bucket, including the empty ones", () => {
    // A gap in the histogram must render as a zero-height bar, not a missing column:
    // ten columns with one absent reads as a nine-point scale.
    const out = buildBdAnalytics([row({ fit_score: 9 })], NOW);
    expect(out.distribution).toHaveLength(10);
    expect(out.distribution.find((d) => d.score === 9)!.count).toBe(1);
    expect(out.distribution.find((d) => d.score === 3)!.count).toBe(0);
  });

  it("counts strong-and-live, not strong-or-live", () => {
    const out = buildBdAnalytics(
      [
        row({ fit_score: 9, response_deadline: "2026-10-01T00:00:00Z" }), // both
        row({ fit_score: 9, response_deadline: "2026-01-01T00:00:00Z" }), // strong, expired
        row({ fit_score: 3, response_deadline: "2026-10-01T00:00:00Z" }), // live, weak
      ],
      NOW,
    );
    expect(out.strongLive).toBe(1);
    expect(out.liveCount).toBe(2);
  });

  it("treats an unscored row as unscored rather than as a zero", () => {
    const out = buildBdAnalytics([row({ fit_score: 8 }), row({ fit_score: null })], NOW);
    expect(out.avgFit).toBe(8); // not 4
  });

  it("survives an empty table", () => {
    const out = buildBdAnalytics([], NOW);
    expect(out.total).toBe(0);
    expect(out.avgFit).toBeNull();
    expect(out.distribution).toHaveLength(10);
    expect(out.byAgency).toEqual([]);
  });

  it("uses the same strong-fit threshold the sweep derives 'pursue' from", () => {
    expect(STRONG_FIT).toBe(7);
  });
});

describe("mean", () => {
  it("rounds to one decimal, which is what the page shows", () => {
    expect(mean([5, 6, 8])).toBe(6.3);
  });
  it("returns null for nothing, rather than NaN or 0", () => {
    expect(mean([])).toBeNull();
  });
});
