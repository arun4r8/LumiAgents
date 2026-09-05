import { describe, it, expect } from "vitest";
import { isoDay, resolveEventDate, resolveResponseDeadline } from "../../../orchestrations/beady/industry-day-sweep/definition";

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
  it("takes a well-formed model answer", () => {
    expect(resolveEventDate("2026-09-15")).toBe("2026-09-15");
  });

  it("returns null when the model could not determine a date", () => {
    // Null is the TRUE answer when the notice does not state when the event happens.
    // SAM.gov has no event-date field, so there is nothing honest to fall back to.
    expect(resolveEventDate(null)).toBeNull();
  });

  it("rejects a format the DATE column would not take", () => {
    for (const bad of ["September 15, 2026", "2026-09-15T00:00:00Z", "09/15/2026", "TBD", ""]) {
      expect(resolveEventDate(bad)).toBeNull();
    }
  });

  it("never absorbs the response deadline", () => {
    // The regression this replaced: responseDeadLine standing in for the event date
    // produced an event dated 2026-06-10 on a notice swept 2026-09-05. resolveEventDate
    // has no access to that value any more, by signature -- it takes one argument.
    expect(resolveEventDate.length).toBe(1);
  });
});

describe("resolveResponseDeadline", () => {
  it("keeps a well-formed SAM.gov date", () => {
    expect(resolveResponseDeadline("2026-06-10")).toBe("2026-06-10");
  });

  it("is null for web rows, which have no structured date", () => {
    expect(resolveResponseDeadline(null)).toBeNull();
  });

  it("validates rather than trusting its caller", () => {
    for (const bad of ["not-a-date", "2026-6-1", ""]) {
      expect(resolveResponseDeadline(bad)).toBeNull();
    }
  });
});

describe("the two dates stay independent", () => {
  it("a notice with only a deadline yields no event date", () => {
    // The DCSA case: SAM.gov gave a responseDeadLine, the content gave no event date.
    // The row should record the deadline and admit the event date is unknown.
    expect(resolveEventDate(null)).toBeNull();
    expect(resolveResponseDeadline(isoDay("2026-06-10T17:00:00-04:00"))).toBe("2026-06-10");
  });

  it("a notice stating its date yields both, unmixed", () => {
    // "HAESI 2.0 INDUSTRY DAY 05 AUG 2026" -- the model reads the title correctly.
    expect(resolveEventDate("2026-08-05")).toBe("2026-08-05");
    expect(resolveResponseDeadline("2026-07-29")).toBe("2026-07-29");
  });
});
