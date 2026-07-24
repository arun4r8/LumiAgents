import { z } from "zod";
import { defineTool } from "../../runtime/src";
import { claimBudget, DAILY_BUDGET } from "../budget";
import { callJson } from "../http";

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const samSearchInputSchema = z.object({
  keywords: z.string().optional().describe("Title search (matches the SAM notice title, e.g. 'artificial intelligence governance')"),
  naicsCodes: z
    .array(z.string())
    .optional()
    .describe("NAICS codes to filter by (e.g. ['541512', '541511'])"),
  agencies: z.array(z.string()).optional().describe("Agency names to filter (partial match)"),
  postedWithinDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30)
    .describe("Only return opportunities posted in the last N days"),
  limit: z.number().int().min(1).max(100).default(25),
  activeOnly: z.boolean().default(true),
  ptypes: z
    .array(z.string())
    .optional()
    .describe("SAM procurement types to include: o=Solicitation, p=Presolicitation, r=Sources Sought, k=Combined Synopsis/Solicitation. Joined comma-separated in the API call. Defaults to Solicitations only."),
});

export const samOpportunitySchema = z.object({
  noticeId: z.string(),
  solicitationNumber: z.string().nullable(),
  title: z.string(),
  agency: z.string().nullable(),
  subAgency: z.string().nullable(),
  naicsCode: z.string().nullable(),
  setAside: z.string().nullable(),
  responseDeadline: z.string().nullable().describe("ISO date string"),
  postedDate: z.string().nullable().describe("ISO date string"),
  description: z.string().nullable().describe("Truncated opportunity description"),
  sourceUrl: z.string().describe("SAM.gov browse URL for this notice"),
  noticeType: z.string().nullable().describe("SAM notice type, e.g. 'Solicitation', 'Sources Sought', 'Presolicitation'"),
});

export const samSearchOutputSchema = z.object({
  totalRecords: z.number(),
  opportunities: z.array(samOpportunitySchema),
});

export type SamOpportunity = z.infer<typeof samOpportunitySchema>;

// ─── Raw SAM.gov response types ───────────────────────────────────────────────

interface RawSamOpportunity {
  noticeId?: string;
  solicitationNumber?: string;
  title?: string;
  fullParentPathName?: string;      // "DEPT OF DEFENSE > ARMY > ..."
  naicsCode?: string;
  typeOfSetAside?: string;
  responseDeadLine?: string;
  postedDate?: string;
  description?: string;
  uiLink?: string;
  type?: string;                    // "Solicitation", "Sources Sought", "Presolicitation", ...
}

interface RawSamResponse {
  totalRecords?: number;
  opportunitiesData?: RawSamOpportunity[];
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export const samGovOpportunitySearch = defineTool({
  name: "samGovOpportunitySearch",
  inputSchema: samSearchInputSchema,
  outputSchema: samSearchOutputSchema,
  async run(ctx, input) {
    if (!(await claimBudget(ctx.env, "sam_gov", DAILY_BUDGET.sam_gov))) {
      throw new Error(`SAM.gov daily budget reached (${DAILY_BUDGET.sam_gov}/day). Try again tomorrow or raise the cap in DAILY_BUDGET.`);
    }
    // Build date range
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - input.postedWithinDays);

    const fmt = (d: Date) =>
      `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

    const params = new URLSearchParams({
      api_key: ctx.env.SAM_GOV_API_KEY,
      limit: String(input.limit),
      postedFrom: fmt(fromDate),
      postedTo: fmt(toDate),
      ptype: (input.ptypes && input.ptypes.length > 0 ? input.ptypes : ["o"]).join(","),
    });

    if (input.activeOnly) params.set("status", "active");
    // SAM v2 has no free-text "keywords" param (it was silently ignored); `title`
    // is the supported text search, matching against the notice title.
    if (input.keywords) params.set("title", input.keywords);
    if (input.naicsCodes && input.naicsCodes.length > 0) {
      params.set("naicsCode", input.naicsCodes.join(","));
    }

    const url = `https://api.sam.gov/opportunities/v2/search?${params.toString()}`;
    const raw = await callJson<RawSamResponse>(
      ctx.fetch,
      url,
      { headers: { Accept: "application/json" } },
      { label: "SAM.gov API" },
    );
    const rawOpps = raw.opportunitiesData ?? [];

    // Optionally filter by agency name substring
    const filtered = input.agencies && input.agencies.length > 0
      ? rawOpps.filter((o) => {
          const path = (o.fullParentPathName ?? "").toLowerCase();
          return (input.agencies as string[]).some((a) => path.includes(a.toLowerCase()));
        })
      : rawOpps;

    const opportunities: SamOpportunity[] = filtered.map((o) => {
      // Parse agency hierarchy: take last meaningful segment
      const pathParts = (o.fullParentPathName ?? "")
        .split(">")
        .map((s) => s.trim())
        .filter(Boolean);

      return {
        noticeId: o.noticeId ?? "",
        solicitationNumber: o.solicitationNumber ?? null,
        title: o.title ?? "",
        agency: pathParts[0] ?? null,
        subAgency: pathParts[1] ?? null,
        naicsCode: o.naicsCode ?? null,
        setAside: o.typeOfSetAside ?? null,
        responseDeadline: o.responseDeadLine ?? null,
        postedDate: o.postedDate ?? null,
        description: o.description ? o.description.slice(0, 800) : null,
        sourceUrl: o.uiLink ?? `https://sam.gov/opp/${o.noticeId ?? ""}/view`,
        noticeType: o.type ?? null,
      };
    });

    return {
      totalRecords: raw.totalRecords ?? opportunities.length,
      opportunities,
    };
  },
});
