/**
 * Aggregation for the BD half of the analytics page.
 *
 * Pure, and in its own file, because these are the numbers people will act on and
 * numbers buried in a page component cannot be tested. A wrong bar chart is not
 * obviously wrong — it looks like data.
 */

export interface AnalyticsRow {
  agency: string | null;
  naics_code: string | null;
  fit_score: number | null;
  disposition: string | null;
  response_deadline: string | null;
  notice_text_fetched_at: string | null;
}

export interface Bucket {
  label: string;
  total: number;
  strong: number;
  live: number;
  avgFit: number | null;
}

export interface BdAnalytics {
  total: number;
  liveCount: number;
  strongLive: number;
  avgFit: number | null;
  triaged: number;
  pursued: number;
  bodyScored: number;
  distribution: { score: number; count: number }[];
  byAgency: Bucket[];
  byNaics: Bucket[];
}

/** A fit of 7 or more is Beady's "pursue" band. Same threshold the sweep derives from. */
export const STRONG_FIT = 7;

export function mean(ns: number[]): number | null {
  if (ns.length === 0) return null;
  return Math.round((ns.reduce((a, b) => a + b, 0) / ns.length) * 10) / 10;
}

/**
 * A deadline in the future. A NULL deadline is deliberately NOT live: unknown is
 * not the same as open, and counting unknowns as actionable would overstate the
 * pipeline — the mistake the opportunities list already avoids for its own filter.
 */
export function isLive(row: AnalyticsRow, now: number): boolean {
  return row.response_deadline !== null && new Date(row.response_deadline).getTime() > now;
}

export function groupBy(
  rows: AnalyticsRow[],
  key: (r: AnalyticsRow) => string | null,
  now: number,
): Bucket[] {
  const buckets = new Map<string, AnalyticsRow[]>();
  for (const r of rows) {
    const k = key(r);
    // A null grouping key is skipped rather than bucketed as "unknown": an
    // opportunity with no NAICS says nothing about NAICS performance, and putting
    // it in a bucket invites someone to read that bucket as a code.
    if (k === null) continue;
    buckets.set(k, [...(buckets.get(k) ?? []), r]);
  }
  return [...buckets]
    .map(([label, rs]) => ({
      label,
      total: rs.length,
      strong: rs.filter((r) => (r.fit_score ?? 0) >= STRONG_FIT).length,
      live: rs.filter((r) => isLive(r, now)).length,
      avgFit: mean(rs.map((r) => r.fit_score).filter((n): n is number => typeof n === "number")),
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

export function buildBdAnalytics(rows: AnalyticsRow[], now: number): BdAnalytics {
  const scored = rows.filter((r) => typeof r.fit_score === "number");
  const live = rows.filter((r) => isLive(r, now));

  return {
    total: rows.length,
    liveCount: live.length,
    strongLive: live.filter((r) => (r.fit_score ?? 0) >= STRONG_FIT).length,
    avgFit: mean(scored.map((r) => r.fit_score as number)),
    triaged: rows.filter((r) => r.disposition !== null).length,
    pursued: rows.filter((r) => r.disposition === "pursue").length,
    // Rows whose notice body has been fetched. The remainder were scored on their
    // title alone, which is the caveat the page leads with.
    bodyScored: rows.filter((r) => r.notice_text_fetched_at !== null).length,
    distribution: Array.from({ length: 10 }, (_, i) => ({
      score: i + 1,
      count: scored.filter((r) => r.fit_score === i + 1).length,
    })),
    byAgency: groupBy(rows, (r) => r.agency, now),
    byNaics: groupBy(rows, (r) => r.naics_code, now),
  };
}
