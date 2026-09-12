import { describe, it, expect } from "vitest";
import {
  indexHeaders, mapRow, parseNaics, parseValueUsd, parseDeadline, selectForScoring,
  type GovWinRow,
} from "../../../integrations/govwin/import";

/**
 * Fixtures are real rows from BD's export, not invented ones. A mis-mapped column
 * here is invisible: it produces a plausible row rather than an error, which is how
 * SAM's `description` field passed a URL to the scoring model for months (#219).
 */

const HEADER = [
  "Status", "Opp Type", "Opp ID", "Program Name", "Acronym", "Agency Assigned Priority",
  "Department", "Email", "Organization Level 1", "Organization Level 2", "Solicitation Number",
  "Value (USD-$K)", "Duration", "Primary Requirement", "Latest News", "Summary", "Contract Value",
  "Solicitation Date", "Solicitation Date (Actual/Estimate)", "Response Date", "Projected Award Date",
  "Projected Award Date (Actual/Estimate)", "Type of Award", "Competition Type", "Incumbent/Contractor",
  "Contract Award Date", "Contract Numbers", "Contract Type", "Contract Vehicle", "NAICS",
  "Last Updated", "Created Date",
];
const idx = indexHeaders(HEADER);

/** The VA EDW row, verbatim from the export. */
const EDW = [
  "Forecast Pre-RFP", "Tracked Opportunities", "253593", "ENTERPRISE DATA WAREHOUSE SUPPORT SERVICES (EDW)",
  "EDW", "", "", "dana.newcomb@va.gov", "VETERANS AFFAIRS", "VETERANS BENEFITS ADMINISTRATION", "",
  "57,769", "12 month(s) base plus 4 x 12 month(s) option(s)", "Information Technology",
  "The 2nd Option Period has been exercised", "The Department of Veterans Affairs, VBA...", "57769",
  "12/2028", "(Deltek Estimate)", "", "02/2029", "(Deltek Estimate)", "Task / Delivery Order",
  "Service Disabled Veteran Owned Small Business", "9TH WAY INSIGNIA", "02/09/2024",
  "[C]VA11816D1025", "Firm Fixed Price", "T4NG - TRANSFORMATION TWENTY ONE", "541512 - Computer Systems Design Services",
  "02/23/2026", "04/09/2025",
];

describe("parseValueUsd", () => {
  it("reads GovWin's thousands as dollars", () => {
    // The header says "Contract Value" and the figure is in THOUSANDS -- only the
    // neighbouring column admits it, as "Value (USD-$K)". Read as dollars, a $57.8M
    // pursuit shows as $57,769 and reads like a rounding error rather than an error.
    expect(parseValueUsd("57769")).toBe(57_769_000);
    expect(parseValueUsd("12,607")).toBe(12_607_000);
    expect(parseValueUsd("$1,250")).toBe(1_250_000);
  });

  it("returns null rather than 0 when there is no figure", () => {
    // 0 would render as "$0" on a card, which reads as "worth nothing" rather than
    // "not known" -- and GovWin leaves this blank on 25% of rows.
    expect(parseValueUsd("")).toBeNull();
    expect(parseValueUsd("TBD")).toBeNull();
    expect(parseValueUsd("n/a")).toBeNull();
  });
});

describe("parseNaics", () => {
  it("takes the code off the front of GovWin's label", () => {
    expect(parseNaics("541512 - Computer Systems Design Services")).toBe("541512");
    expect(parseNaics("  541611 - Admin Management Consulting  ")).toBe("541611");
  });

  it("returns null rather than a partial code", () => {
    // A truncated NAICS silently joins the wrong bucket on the analytics page.
    expect(parseNaics("5415 - too short")).toBeNull();
    expect(parseNaics("")).toBeNull();
    expect(parseNaics("Information Technology")).toBeNull();
  });
});

describe("parseDeadline", () => {
  it("prefers a real response date", () => {
    expect(parseDeadline("03/15/2026", "01/2026")).toBe("2026-03-15");
  });

  it("falls back to the first of the forecast solicitation month", () => {
    // Pre-RFP rows have only MM/YYYY. The first of that month is the honest reading.
    expect(parseDeadline("", "12/2028")).toBe("2028-12-01");
    expect(parseDeadline("", "1/2027")).toBe("2027-01-01");
  });

  it("returns null when GovWin has neither, rather than inventing today", () => {
    expect(parseDeadline("", "")).toBeNull();
  });
});

describe("mapRow", () => {
  const row = mapRow(EDW, idx)!;

  it("pulls the fields SAM.gov cannot give us", () => {
    expect(row.estimatedValueUsd).toBe(57_769_000);
    expect(row.incumbent).toBe("9TH WAY INSIGNIA");
    expect(row.summary).toContain("Department of Veterans Affairs");
    expect(row.vehicle).toContain("T4NG");
  });

  it("maps agency and sub-agency to the right columns", () => {
    // Organization Level 1/2, NOT "Department" -- which is blank on this row and on
    // most of the export, and would have produced a null agency on every import.
    expect(row.agency).toBe("VETERANS AFFAIRS");
    expect(row.subAgency).toBe("VETERANS BENEFITS ADMINISTRATION");
  });

  it("uses Competition Type as the set-aside", () => {
    expect(row.setAside).toBe("Service Disabled Veteran Owned Small Business");
  });

  it("rejects a row with no id or no title", () => {
    // Hand-maintained exports carry spacer and footer rows.
    expect(mapRow(HEADER.map(() => ""), idx)).toBeNull();
    const noTitle = [...EDW]; noTitle[3] = "";
    expect(mapRow(noTitle, idx)).toBeNull();
  });

  it("matches headers case-insensitively, since the export is hand-maintained", () => {
    const shouty = indexHeaders(HEADER.map((h) => h.toUpperCase()));
    expect(mapRow(EDW, shouty)?.externalId).toBe("253593");
  });
});

describe("selectForScoring", () => {
  const NOW = new Date("2026-09-12T00:00:00Z");
  const base: GovWinRow = {
    externalId: "1", title: "t", status: null, agency: null, subAgency: null,
    solicitationNumber: null, estimatedValueUsd: null, summary: null,
    naicsCode: "541512", setAside: null, incumbent: null, vehicle: null,
    responseDeadline: "2026-11-01",
  };
  const opts = { naicsCodes: ["541512", "541511", "541519", "518210", "541611"], horizonMonths: 18, now: NOW };

  it("keeps a pursuit inside the horizon", () => {
    expect(selectForScoring([base], opts)).toHaveLength(1);
  });

  it("drops one soliciting years out", () => {
    // 12/2028 is real and is not this quarter's work. The export reaches to 2029.
    expect(selectForScoring([{ ...base, responseDeadline: "2028-12-01" }], opts)).toEqual([]);
  });

  it("drops one whose date has already passed", () => {
    expect(selectForScoring([{ ...base, responseDeadline: "2026-01-01" }], opts)).toEqual([]);
  });

  it("KEEPS a row with no date at all", () => {
    // GovWin leaves this blank on early forecasts. Dropping them would discard
    // exactly the pre-RFP visibility this source exists to provide.
    expect(selectForScoring([{ ...base, responseDeadline: null }], opts)).toHaveLength(1);
  });

  it("drops a NAICS outside the configured list", () => {
    expect(selectForScoring([{ ...base, naicsCode: "236220" }], opts)).toEqual([]);
  });

  it("keeps a row whose NAICS GovWin did not record", () => {
    // Unknown is not disqualifying; 20% of the export has no parseable code.
    expect(selectForScoring([{ ...base, naicsCode: null }], opts)).toHaveLength(1);
  });
});

/**
 * The wiring, not the parts.
 *
 * Header indexing, row mapping, the NAICS/horizon cut and the cap are each tested
 * above and each fine in isolation. #219 shipped exactly that -- a tested predicate
 * and a tested schema joined by an untested call -- and the bug was in the join. So
 * this runs real grids through the function the orchestration actually calls.
 */
describe("rowsToScore (the orchestration's own path from sheets to scoring set)", () => {
  const now = new Date("2026-09-12T00:00:00Z");
  const opts = { naicsCodes: ["541512", "541511"], horizonMonths: 18, now };

  const load = () => import("../../../orchestrations/beady/govwin-import/definition");

  function book(name: string, rows: string[][], webUrl: string | null = `https://x/${name}`) {
    return { name, webUrl, grid: [HEADER, ...rows] };
  }

  function rowWith(overrides: Record<string, string>): string[] {
    const r = [...EDW];
    for (const [header, value] of Object.entries(overrides)) {
      r[HEADER.indexOf(header)] = value;
    }
    return r;
  }

  const SOON = { "Response Date": "11/14/2026" };

  it("maps a real export row end to end and keeps its provenance", async () => {
    const { rowsToScore } = await load();
    const { mapped, selected } = rowsToScore([book("VA.xlsx", [rowWith(SOON)])], opts);
    expect(mapped).toHaveLength(1);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.estimatedValueUsd).toBe(57_769_000);
    expect(selected[0]!.incumbent).toBe("9TH WAY INSIGNIA");
    expect(selected[0]!.naicsCode).toBe("541512");
    // Provenance is per FILE: there is no per-row GovWin URL to link, so the export
    // a row came from is the only answer to "where did this come from".
    expect(selected[0]!.sourceFile).toBe("VA.xlsx");
    expect(selected[0]!.sourceUrl).toBe("https://x/VA.xlsx");
  });

  it("deduplicates the same pursuit appearing in two exports", async () => {
    const { rowsToScore } = await load();
    // A VA pursuit is in both VA.xlsx and Upcoming Deals. Two rows with one external
    // id in a single upsert make Postgres throw "ON CONFLICT DO UPDATE command
    // cannot affect row a second time", which loses the whole batch -- not the
    // duplicate. The import must never hand it two.
    const { mapped } = rowsToScore(
      [book("VA.xlsx", [rowWith(SOON)]), book("Upcoming Deals.xlsx", [rowWith(SOON)])],
      opts,
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.sourceFile).toBe("VA.xlsx"); // first workbook wins, stably
  });

  it("still keeps distinct rows from several exports", async () => {
    const { rowsToScore } = await load();
    const { mapped } = rowsToScore(
      [
        book("VA.xlsx", [rowWith({ ...SOON, "Opp ID": "111" })]),
        book("State Local.xlsx", [rowWith({ ...SOON, "Opp ID": "222" })]),
        book("Upcoming Deals.xlsx", [rowWith({ ...SOON, "Opp ID": "333" })]),
      ],
      opts,
    );
    expect(mapped.map((r) => r.externalId)).toEqual(["111", "222", "333"]);
  });

  it("drops spacer and footer rows without dropping the sheet", async () => {
    const { rowsToScore } = await load();
    const { mapped } = rowsToScore(
      [book("VA.xlsx", [rowWith(SOON), [], ["", "", "", ""], rowWith({ ...SOON, "Opp ID": "999" })])],
      opts,
    );
    expect(mapped).toHaveLength(2);
  });

  it("caps the scoring set however big the exports are", async () => {
    const { rowsToScore, MAX_ROWS_TO_SCORE } = await load();
    // Uncapped, this many rows is ~50 scoring batches at 3 subrequests each against
    // a ceiling of 50 for the whole run.
    const many = Array.from({ length: MAX_ROWS_TO_SCORE + 500 }, (_, i) =>
      rowWith({ ...SOON, "Opp ID": String(900000 + i) }),
    );
    const { mapped, selected } = rowsToScore([book("VA.xlsx", many)], opts);
    expect(mapped).toHaveLength(MAX_ROWS_TO_SCORE + 500);
    expect(selected).toHaveLength(MAX_ROWS_TO_SCORE);
  });

  it("applies the horizon, so a 2029 forecast is not this week's work", async () => {
    const { rowsToScore } = await load();
    // The EDW row as it actually stands: no Response Date, soliciting 12/2028.
    expect(rowsToScore([book("VA.xlsx", [EDW])], opts).selected).toHaveLength(0);
  });

  it("applies the NAICS filter through the mapped code, not the raw cell", async () => {
    const { rowsToScore } = await load();
    const construction = rowWith({
      ...SOON,
      NAICS: "236220 - Commercial and Institutional Building Construction",
    });
    const { mapped, selected } = rowsToScore([book("VA.xlsx", [construction])], opts);
    expect(mapped).toHaveLength(1);
    expect(selected).toHaveLength(0);
  });

  it("survives header-only and empty sheets among real ones", async () => {
    const { rowsToScore } = await load();
    expect(rowsToScore([], opts)).toEqual({ mapped: [], selected: [] });
    const { mapped } = rowsToScore(
      [book("Empty.xlsx", []), { name: "Blank.xlsx", webUrl: null, grid: [] }, book("VA.xlsx", [rowWith(SOON)])],
      opts,
    );
    expect(mapped).toHaveLength(1);
  });

  it("maps nothing from a workbook that is not a GovWin export", async () => {
    const { rowsToScore } = await load();
    // A sheet with no "Opp ID" column maps every row to null. It must contribute
    // nothing rather than contributing garbage rows with empty ids.
    const foreign = { name: "Budget.xlsx", webUrl: null, grid: [["Month", "Spend"], ["January", "12000"]] };
    expect(rowsToScore([foreign], opts).mapped).toHaveLength(0);
  });
});
