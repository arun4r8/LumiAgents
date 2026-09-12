/**
 * GovWin IQ (Deltek) opportunity-export mapping.
 *
 * BD maintains a GovWin export by hand in SharePoint and works from it directly.
 * That spreadsheet is where the pursuits the SAM.gov sweep cannot see actually
 * live: GSA eBuy RFQs, agency forecasts, anything pre-solicitation. The Advana /
 * Army Vantage pursuit BD is running right now is GSA eBuy RFQ1835138, which is
 * visible only to schedule holders on the eBuy portal and is never posted to SAM.
 *
 * So this is not a second copy of the sweep. It is the FORECAST half of the
 * pipeline, and it carries three things SAM.gov does not give us at all:
 * a contract value, a named incumbent, and a written summary.
 *
 * Pure functions, no I/O, because these are the numbers a person will act on and a
 * mis-mapped column is invisible: it produces a plausible row rather than an error.
 */

/** Column headers as GovWin exports them. Matched case-insensitively and trimmed. */
export const GOVWIN_COLUMNS = {
  id: "Opp ID",
  title: "Program Name",
  status: "Status",
  department: "Organization Level 1",
  subAgency: "Organization Level 2",
  solicitationNumber: "Solicitation Number",
  valueThousands: "Contract Value",
  summary: "Summary",
  naics: "NAICS",
  competitionType: "Competition Type",
  incumbent: "Incumbent/Contractor",
  vehicle: "Contract Vehicle",
  solicitationDate: "Solicitation Date",
  responseDate: "Response Date",
  primaryRequirement: "Primary Requirement",
} as const;

export interface GovWinRow {
  externalId: string;
  title: string;
  status: string | null;
  agency: string | null;
  subAgency: string | null;
  solicitationNumber: string | null;
  /** USD. GovWin exports thousands in "Contract Value"; this is the real figure. */
  estimatedValueUsd: number | null;
  summary: string | null;
  naicsCode: string | null;
  setAside: string | null;
  incumbent: string | null;
  vehicle: string | null;
  /** ISO date, from Response Date when present, else the first of the solicitation month. */
  responseDeadline: string | null;
}

/** Header row → index, tolerant of case and stray whitespace. */
export function indexHeaders(header: string[]): Map<string, number> {
  const out = new Map<string, number>();
  header.forEach((h, i) => out.set(h.trim().toLowerCase(), i));
  return out;
}

const cell = (row: string[], idx: Map<string, number>, name: string): string => {
  const i = idx.get(name.trim().toLowerCase());
  return i === undefined ? "" : (row[i] ?? "").trim();
};

/**
 * "541511 - Custom Computer Programming Services" -> "541511".
 * Returns null rather than a partial code: a truncated NAICS silently joins the
 * wrong bucket on the analytics page.
 */
export function parseNaics(raw: string): string | null {
  const m = /^\s*(\d{6})\b/.exec(raw);
  return m ? m[1]! : null;
}

/**
 * GovWin reports "Contract Value" in THOUSANDS of dollars, which the column header
 * does not say -- the neighbouring column is the one labelled "Value (USD-$K)".
 * Reading it as dollars understates every opportunity by 1000x, and a $12.6M
 * pursuit shown as $12,607 looks like a rounding error rather than a mistake.
 */
export function parseValueUsd(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 1000);
}

/**
 * A usable deadline. GovWin gives "Response Date" only once a solicitation is real;
 * before that there is a "Solicitation Date" of the form MM/YYYY, which is a
 * forecast month. The first of that month is the honest reading of it.
 */
export function parseDeadline(responseDate: string, solicitationDate: string): string | null {
  const iso = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(responseDate.trim());
  if (iso) {
    const [, m, d, y] = iso;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  const month = /^(\d{1,2})\/(\d{4})$/.exec(solicitationDate.trim());
  if (month) {
    const [, m, y] = month;
    return `${y}-${m!.padStart(2, "0")}-01`;
  }
  return null;
}

export function mapRow(row: string[], idx: Map<string, number>): GovWinRow | null {
  const externalId = cell(row, idx, GOVWIN_COLUMNS.id);
  const title = cell(row, idx, GOVWIN_COLUMNS.title);
  // Both are required to be a row at all. A row with neither is a spacer or a
  // footer, of which hand-maintained exports have plenty.
  if (!externalId || !title) return null;

  return {
    externalId,
    title,
    status: cell(row, idx, GOVWIN_COLUMNS.status) || null,
    agency: cell(row, idx, GOVWIN_COLUMNS.department) || null,
    subAgency: cell(row, idx, GOVWIN_COLUMNS.subAgency) || null,
    solicitationNumber: cell(row, idx, GOVWIN_COLUMNS.solicitationNumber) || null,
    estimatedValueUsd: parseValueUsd(cell(row, idx, GOVWIN_COLUMNS.valueThousands)),
    summary: cell(row, idx, GOVWIN_COLUMNS.summary) || null,
    naicsCode: parseNaics(cell(row, idx, GOVWIN_COLUMNS.naics)),
    setAside: cell(row, idx, GOVWIN_COLUMNS.competitionType) || null,
    incumbent: cell(row, idx, GOVWIN_COLUMNS.incumbent) || null,
    vehicle: cell(row, idx, GOVWIN_COLUMNS.vehicle) || null,
    responseDeadline: parseDeadline(
      cell(row, idx, GOVWIN_COLUMNS.responseDate),
      cell(row, idx, GOVWIN_COLUMNS.solicitationDate),
    ),
  };
}

export interface FilterOptions {
  naicsCodes: string[];
  /** Drop anything whose deadline is further out than this. */
  horizonMonths: number;
  now: Date;
}

/**
 * Which rows are worth scoring.
 *
 * The export runs to thousands of rows and scoring is the expensive part, so the
 * cut happens here, deterministically, before any LLM call -- the same shape as the
 * sweep, and for the same reason.
 *
 * Deadline is the sharp filter rather than NAICS: BD has already filtered the export
 * by sector (83% of it matches our five codes), but it reaches years into the
 * future. A pursuit soliciting in 2029 is real and is not this quarter's work.
 */
export function selectForScoring(rows: GovWinRow[], opts: FilterOptions): GovWinRow[] {
  const horizon = new Date(opts.now);
  horizon.setMonth(horizon.getMonth() + opts.horizonMonths);
  const codes = new Set(opts.naicsCodes);

  return rows.filter((r) => {
    if (r.naicsCode !== null && !codes.has(r.naicsCode)) return false;
    // A missing deadline is KEPT. GovWin leaves it blank on early forecasts, and
    // dropping those would discard exactly the pre-RFP visibility this source is for.
    if (r.responseDeadline === null) return true;
    const due = new Date(r.responseDeadline);
    return due >= opts.now && due <= horizon;
  });
}
