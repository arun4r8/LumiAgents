import { describe, it, expect } from "vitest";
import { splitAgencyPath } from "../../../integrations/sam-gov/opportunity-search";

/**
 * `fullParentPathName` is PERIOD-delimited. The parser split on ">", which never
 * matches, so `agency` held the entire undivided path and `subAgency` was null.
 * All 155 rows in production carried a value like
 *
 *   "VETERANS AFFAIRS, DEPARTMENT OF.VETERANS AFFAIRS, DEPARTMENT OF.TECHNOLOGY ACQUISITION CENTER"
 *
 * as their "agency" — written to the database, shown on the card, and handed to the
 * scoring model as the agency for every SAM notice.
 *
 * Real strings below are taken from production rows and from the API documentation's
 * own example, not invented.
 */
describe("splitAgencyPath", () => {
  it("splits on the period, which is the delimiter SAM actually uses", () => {
    expect(
      splitAgencyPath(
        "GENERAL SERVICES ADMINISTRATION.FEDERAL ACQUISITION SERVICE.GSA/FAS CENTER FOR IT SCHEDULE PROG",
        "047.4732.47QTCA",
      ),
    ).toEqual([
      "GENERAL SERVICES ADMINISTRATION",
      "FEDERAL ACQUISITION SERVICE",
      "GSA/FAS CENTER FOR IT SCHEDULE PROG",
    ]);
  });

  it("never returns the whole path as one segment", () => {
    const parts = splitAgencyPath(
      "COMMERCE, DEPARTMENT OF.NATIONAL OCEANIC AND ATMOSPHERIC ADMINISTRATION.DEPT OF COMMERCE NOAA",
      "013.1330.NOAA",
    );
    expect(parts[0]).toBe("COMMERCE, DEPARTMENT OF");
    expect(parts[0]).not.toContain(".");
  });

  it("keeps commas inside a segment — only periods delimit", () => {
    const parts = splitAgencyPath(
      "VETERANS AFFAIRS, DEPARTMENT OF.VETERANS AFFAIRS, DEPARTMENT OF.TECHNOLOGY ACQUISITION CENTER",
      "036.3600.TAC",
    );
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("VETERANS AFFAIRS, DEPARTMENT OF");
  });

  it("handles the deep DoD paths that dominate the sweep", () => {
    const parts = splitAgencyPath(
      "DEPT OF DEFENSE.DEPT OF THE NAVY.NAVSUP.NAVSUP GLOBAL LOGISTICS SUPPORT.NAVSUP FLC NORFOLK",
      "097.1700.NAVSUP.GLS.N00189",
    );
    expect(parts[0]).toBe("DEPT OF DEFENSE");
    expect(parts[1]).toBe("DEPT OF THE NAVY");
    expect(parts).toHaveLength(5);
  });

  it("does not let a period inside a name shift the hierarchy", () => {
    // The code says three levels; the name splits into four because of "U.S.".
    // The department and sub-agency must stay put, with the surplus folded into
    // the deepest segment rather than pushing everything along by one.
    const parts = splitAgencyPath(
      "DEPT OF DEFENSE.DEPT OF THE ARMY.U.S. ARMY CORPS OF ENGINEERS",
      "097.2100.USACE",
    );
    expect(parts[0]).toBe("DEPT OF DEFENSE");
    expect(parts[1]).toBe("DEPT OF THE ARMY");
    expect(parts).toHaveLength(3);
  });

  it("survives the field being absent", () => {
    expect(splitAgencyPath(undefined, undefined)).toEqual([]);
    expect(splitAgencyPath("", "")).toEqual([]);
    expect(splitAgencyPath("SELECTIVE SERVICE SYSTEM", undefined)).toEqual(["SELECTIVE SERVICE SYSTEM"]);
  });
});
