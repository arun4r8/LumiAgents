import { describe, it, expect } from "vitest";
import { isoDay, resolveEventDate } from "../../../orchestrations/beady/industry-day-sweep/definition";

/**
 * 40 of 48 industry days had a null event_date. The model was not at fault: the sweep
 * destructured SAM.gov's response down to title/description/url and threw the API's
 * structured date fields away, then asked the model to find a date in a 1200-character
 * description that usually does not state one.
 */

describe("isoDay", () => {
  it("takes the date part off a SAM.gov timestamp", () => {
    expect(isoDay("2026-09-15T00:00:00-04:00")).toBe("2026-09-15");
    expect(isoDay("2026-09-15")).toBe("2026-09-15");
  });

  it("returns null for anything that does not start with a date", () => {
    for (const bad of [undefined, null, "", "September 15, 2026", "n/a", "15-09-2026"]) {
      expect(isoDay(bad)).toBeNull();
    }
  });
});

describe("resolveEventDate", () => {
  it("prefers a well-formed model answer", () => {
    expect(resolveEventDate("2026-09-15", "2026-01-01")).toBe("2026-09-15");
  });

  it("falls back to the SAM.gov date when the model returns null", () => {
    // The regression: this used to be null, discarding a date the API had supplied.
    expect(resolveEventDate(null, "2026-09-15")).toBe("2026-09-15");
  });

  it("falls back when the model answers in a format the column cannot take", () => {
    // The strict regex still rejects these -- it is what keeps a DATE column clean --
    // but rejection now means "use the structured date", not "store null".
    for (const malformed of ["September 15, 2026", "2026-09-15T00:00:00Z", "09/15/2026", "TBD"]) {
      expect(resolveEventDate(malformed, "2026-09-15")).toBe("2026-09-15");
    }
  });

  it("is null only when neither source has a date", () => {
    expect(resolveEventDate(null, null)).toBeNull();
    expect(resolveEventDate("TBD", null)).toBeNull();
  });

  it("never returns a value the DATE column would reject", () => {
    const cases: Array<[string | null, string | null]> = [
      ["TBD", "2026-09-15"], [null, "2026-09-15"], ["2026-09-15", null], ["bad", "also bad"],
    ];
    for (const [model, source] of cases) {
      const out = resolveEventDate(model, source);
      if (out !== null) expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
