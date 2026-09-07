import { describe, it, expect } from "vitest";
import {
  collectSamOpportunities,
  isDescriptionUrl,
  samSearchInputSchema,
  samSearchOutputSchema,
} from "../../../integrations/sam-gov/opportunity-search";

/**
 * In SAM.gov v2 the `description` field is a LINK, not the notice body:
 *
 *   "description": "https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=…"
 *   "A link to an opportunity description. Note: To download the description, user
 *    should append the public API Key."
 *
 * It was read as prose and passed to the scoring prompt for every notice. Verified
 * against the 2026-09-07 run: 133 of 133 "descriptions" the model was asked to score
 * were URLs. So every fit_score in the database was computed from a title, a NAICS
 * code, a set-aside — and a string that looks like data and carries none.
 *
 * The field is now split. `descriptionUrl` is the link; `description` is the body and
 * is null until something fetches it. A null is honest; a URL masquerading as prose
 * is not, and it is invisible because it type-checks and reads fine in a log.
 */
describe("isDescriptionUrl", () => {
  it("recognises the link SAM actually returns", () => {
    expect(isDescriptionUrl("https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=633f42f2")).toBe(true);
  });

  it("does not mistake real prose for a link", () => {
    expect(isDescriptionUrl("The Government requires enterprise data modernisation services.")).toBe(false);
    expect(isDescriptionUrl("http-based integration is in scope")).toBe(false);
  });

  it("treats absence as absence", () => {
    expect(isDescriptionUrl(null)).toBe(false);
    expect(isDescriptionUrl(undefined)).toBe(false);
    expect(isDescriptionUrl("")).toBe(false);
  });
});

describe("SamOpportunity keeps the link and the body apart", () => {
  const base = {
    noticeId: "n1",
    solicitationNumber: null,
    title: "t",
    agency: null,
    subAgency: null,
    naicsCode: null,
    setAside: null,
    responseDeadline: null,
    postedDate: null,
    sourceUrl: "https://sam.gov/opp/n1/view",
    noticeType: null,
  };

  it("accepts a link in descriptionUrl with a null body", () => {
    const parsed = samSearchOutputSchema.shape.opportunities.element.parse({
      ...base,
      descriptionUrl: "https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=n1",
      description: null,
    });
    expect(parsed.description).toBeNull();
    expect(parsed.descriptionUrl).toContain("noticedesc");
  });

  it("still carries a body when one is genuinely present", () => {
    const parsed = samSearchOutputSchema.shape.opportunities.element.parse({
      ...base,
      descriptionUrl: null,
      description: "The Government requires enterprise data modernisation services.",
    });
    expect(parsed.description).toMatch(/Government requires/);
  });
});


describe("the walk never passes a link off as a body", () => {
  /**
   * This is the test that matters. The two above check the predicate and the schema;
   * neither notices if `normalise` stops using them. The production bug was in the
   * WIRING -- `description: o.description.slice(0, 800)` on a field that holds a URL
   * -- so the guard has to run a real fetch through the real code path.
   */
  it("routes SAM's link to descriptionUrl and leaves the body null", async () => {
    const r = await collectSamOpportunities(
      samSearchInputSchema.parse({ naicsCodes: ["541512"], limit: 2 }),
      async () => ({
        totalRecords: 1,
        opportunitiesData: [
          {
            noticeId: "633f42f2",
            title: "CIO Microsoft Sentinel Implementation FY26",
            description: "https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=633f42f2",
            fullParentPathName: "DEPT OF DEFENSE.DEPT OF THE ARMY",
            fullParentPathCode: "097.2100",
          },
        ],
      }),
    );

    const [opp] = r.opportunities;
    expect(opp!.descriptionUrl).toBe("https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=633f42f2");
    // The scoring prompt reads `description`. A URL here is what produced 133 of 133
    // "descriptions" that were links, and every fit score computed from a title.
    expect(opp!.description).toBeNull();
  });

  it("keeps a real body in description when SAM returns one", async () => {
    const r = await collectSamOpportunities(
      samSearchInputSchema.parse({ naicsCodes: ["541512"], limit: 2 }),
      async () => ({
        totalRecords: 1,
        opportunitiesData: [
          { noticeId: "x", title: "t", description: "The Government requires data modernisation services." },
        ],
      }),
    );
    expect(r.opportunities[0]!.description).toMatch(/Government requires/);
    expect(r.opportunities[0]!.descriptionUrl).toBeNull();
  });
});
