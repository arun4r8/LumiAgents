import { describe, it, expect } from "vitest";
import { sourceLabel, exportLabel } from "../../../dashboard/lib/opportunity-source";

/**
 * The BD pipeline's Source column. "GovWin" alone is not actionable: BD keeps four
 * exports and a state/local row is not a federal forecast. All 65 GovWin rows in
 * production today came from "State Local opportunitySearchResults_07-28-2026.xlsx".
 */
describe("exportLabel", () => {
  it.each([
    ["State Local opportunitySearchResults_07-28-2026.xlsx", "State Local"],
    ["Super Swath opportunitySearchResults_07-28-2026.xlsx", "Super Swath"],
    ["Upcoming Deals opportunitySearchResults_07-28-2026.xlsx", "Upcoming Deals"],
    ["VA.xlsx", "VA"],
  ])("%s -> %s", (file, expected) => {
    expect(exportLabel(file)).toBe(expected);
  });

  it("is null when there is no file, rather than an empty label", () => {
    expect(exportLabel(null)).toBeNull();
    expect(exportLabel("")).toBeNull();
  });

  it("keeps the name when it is only boilerplate, instead of returning nothing", () => {
    expect(exportLabel("opportunitySearchResults_07-28-2026.xlsx")).toBe("opportunitySearchResults_07-28-2026");
  });
});

describe("sourceLabel", () => {
  it("names the system for non-GovWin sources", () => {
    expect(sourceLabel({ source: "sam_gov" })).toBe("SAM.gov");
    expect(sourceLabel({ source: "sbir" })).toBe("SBIR");
  });

  it("names the export for a GovWin row", () => {
    expect(sourceLabel({ source: "govwin", source_file: "Super Swath opportunitySearchResults_07-28-2026.xlsx" }))
      .toBe("GovWin · Super Swath");
  });

  it("says plain GovWin for a row imported before the filename was stored, not a guess", () => {
    expect(sourceLabel({ source: "govwin", source_file: null })).toBe("GovWin");
  });

  it("falls back to the raw value rather than hiding an unknown source", () => {
    expect(sourceLabel({ source: "fedconnect" })).toBe("fedconnect");
    expect(sourceLabel({ source: null })).toBe("Unknown");
  });
});
