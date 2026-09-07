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
    .describe("NAICS codes to filter by (e.g. ['541512', '541511']). SAM's `ncode` accepts one code per request, so each code is searched separately and the results merged."),
  agencies: z.array(z.string()).optional().describe("Agency names to filter (partial match, applied client-side on the returned notices)"),
  postedWithinDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30)
    .describe("Only return opportunities posted in the last N days"),
  limit: z.number().int().min(1).max(1000).default(25).describe("Max notices to return in total, across all NAICS codes"),
  openOnly: z
    .boolean()
    .default(true)
    .describe("Only return notices whose response deadline has not passed (SAM `rdlfrom`). Excludes notices with no stated deadline."),
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
  totalRecords: z.number().describe("How many notices SAM reports as matching the query, summed over the NAICS codes searched. This is the size of the match set, not of `opportunities`."),
  matchedByNaics: z.record(z.number()).describe("totalRecords per NAICS code searched; key '(any)' when no NAICS filter was applied."),
  fetched: z.number().describe("How many notices were actually pulled over the wire before the agency filter and the `limit` cut."),
  requests: z.number().describe("HTTP requests made to SAM (one per page per NAICS code)."),
  truncated: z.boolean().describe("True when the match set is larger than what `limit` allowed us to return."),
  opportunities: z.array(samOpportunitySchema),
});

export type SamOpportunity = z.infer<typeof samOpportunitySchema>;

// ─── Raw SAM.gov response types ───────────────────────────────────────────────

interface RawSamOpportunity {
  noticeId?: string;
  solicitationNumber?: string;
  title?: string;
  // Period-delimited, NOT ">"-delimited. Docs example:
  //   "GENERAL SERVICES ADMINISTRATION.FEDERAL ACQUISITION SERVICE.GSA/FAS CENTER..."
  fullParentPathName?: string;
  fullParentPathCode?: string;      // "047.4732.47QTCA" -- same depth, numeric
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

// ─── Query building ───────────────────────────────────────────────────────────

/** SAM v2 caps `limit` at 1000. Pull full pages so a wide sweep costs few requests. */
export const SAM_PAGE_SIZE = 1000;
/** Per NAICS code. A stop so a runaway match set can't walk forever. */
export const SAM_MAX_PAGES = 10;

const fmtDate = (d: Date) =>
  `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

/**
 * Build one SAM.gov search URL.
 *
 * Every parameter here is one SAM v2 actually reads. It ignores anything it does
 * not recognise silently, with no error and no warning in the response, so a
 * misspelled filter reads as "no filter" and quietly returns the whole corpus:
 * this query used to send `naicsCode` (the v2 name is `ncode`) and `status`
 * (documented "Coming Soon", i.e. not implemented), and so swept every notice
 * posted in the window regardless of NAICS or whether it was still open. Check
 * any new parameter against the published v2 parameter list before adding it.
 * https://open.gsa.gov/api/get-opportunities-public-api/
 */
export function buildSamSearchUrl(
  apiKey: string,
  input: z.infer<typeof samSearchInputSchema>,
  page: { ncode?: string; offset: number; pageSize: number; now?: Date },
): string {
  const now = page.now ?? new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - input.postedWithinDays);

  const params = new URLSearchParams({
    api_key: apiKey,
    limit: String(page.pageSize),
    offset: String(page.offset),
    postedFrom: fmtDate(from),
    postedTo: fmtDate(now),
    ptype: (input.ptypes && input.ptypes.length > 0 ? input.ptypes : ["o"]).join(","),
  });

  // Open notices only. SAM has no working `status` filter, but `rdlfrom` bounds the
  // response deadline, which is the thing we actually mean by "still open". Paired
  // with `rdlto` a year out because SAM caps a two-sided deadline range at one year.
  if (input.openOnly) {
    const rdlto = new Date(now);
    rdlto.setDate(rdlto.getDate() + 364);
    params.set("rdlfrom", fmtDate(now));
    params.set("rdlto", fmtDate(rdlto));
  }

  // SAM v2 has no free-text "keywords" param (it was silently ignored); `title`
  // is the supported text search, matching against the notice title.
  if (input.keywords) params.set("title", input.keywords);
  if (page.ncode) params.set("ncode", page.ncode);

  return `https://api.sam.gov/opportunities/v2/search?${params.toString()}`;
}

/**
 * Split SAM's agency hierarchy.
 *
 * `fullParentPathName` is PERIOD-delimited: "COMMERCE, DEPARTMENT OF.NATIONAL
 * OCEANIC AND ATMOSPHERIC ADMINISTRATION.DEPT OF COMMERCE NOAA". This used to split
 * on ">", which never matches, so `agency` held the entire undivided path and
 * `subAgency` was null -- on all 155 rows in production, and on every notice handed
 * to the scoring model.
 *
 * `fullParentPathCode` is the same hierarchy as dotted numeric codes ("047.4732.
 * 47QTCA") and therefore says how many segments there really are. We use it to
 * guard against a period inside an agency's own name: when the two disagree, trust
 * the code's segment count and rejoin any over-split name parts from the right, so
 * a name containing "U.S." cannot silently shift the hierarchy.
 */
export function splitAgencyPath(pathName?: string, pathCode?: string): string[] {
  const parts = (pathName ?? "").split(".").map((s) => s.trim()).filter(Boolean);
  const depth = (pathCode ?? "").split(".").filter(Boolean).length;
  if (depth === 0 || parts.length <= depth) return parts;

  // Over-split: a name contained a period. Keep the first `depth - 1` segments and
  // fold the surplus back into the last one, which is the deepest office name and
  // the likeliest place for punctuation.
  return [...parts.slice(0, depth - 1), parts.slice(depth - 1).join(".")];
}

function normalise(o: RawSamOpportunity): SamOpportunity {
  const pathParts = splitAgencyPath(o.fullParentPathName, o.fullParentPathCode);

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
}

function matchesAgency(raw: RawSamOpportunity, agencies: string[]): boolean {
  const path = (raw.fullParentPathName ?? "").toLowerCase();
  return agencies.some((a) => path.includes(a.toLowerCase()));
}

// ─── Fan-out and paging ────────────────────────────────────────────────────────

/** Fetches one page of raw SAM results. Injected so the walk below can be tested. */
export type SamPageFetcher = (page: { ncode?: string; offset: number; pageSize: number }) => Promise<RawSamResponse>;

export interface SamCollectResult {
  totalRecords: number;
  matchedByNaics: Record<string, number>;
  fetched: number;
  requests: number;
  truncated: boolean;
  opportunities: SamOpportunity[];
}

/**
 * Walk the match set: one paged query per NAICS code (SAM's `ncode` takes a single
 * code), merged and deduped, stopping at `limit`.
 *
 * Two passes. The first gives every code an equal share, so a big code cannot drain
 * the limit and turn the result into "whichever code was listed first" -- the same
 * arbitrariness this replaced, one level up. The second spends whatever the first
 * pass left unused on the codes that still have matches, so an uneven match set is
 * not clipped for the sake of a fairness rule nobody needed.
 *
 * The first live run showed why the second pass is required: 161 matches split
 * 91/37/19/14 across four codes, an even share of 63 each, and 541330's 91 got cut
 * to 63 while three codes left 91 of their share unspent. 133 of 161 pulled, and
 * `truncated` true, for no reason at all.
 *
 * Pure apart from `fetchPage`, so the fairness and stop conditions are testable
 * without a SAM key.
 */
export async function collectSamOpportunities(
  input: z.infer<typeof samSearchInputSchema>,
  fetchPage: SamPageFetcher,
): Promise<SamCollectResult> {
  const codes: (string | undefined)[] =
    input.naicsCodes && input.naicsCodes.length > 0 ? [...input.naicsCodes] : [undefined];

  const perCode = Math.max(1, Math.ceil(input.limit / codes.length));
  const hasAgencyFilter = Boolean(input.agencies && input.agencies.length > 0);

  const matchedByNaics: Record<string, number> = {};
  const seen = new Set<string>();
  const opportunities: SamOpportunity[] = [];
  // Where each code's walk got to, so the second pass resumes rather than restarts.
  const offsets = new Map<string | undefined, number>();
  // Pages spent per code, counted ACROSS passes: SAM_MAX_PAGES is a budget for the
  // whole walk of a code, not per call, or a second pass would silently double it.
  const pagesUsed = new Map<string | undefined, number>();
  const exhausted = new Set<string | undefined>();
  let fetched = 0;
  let requests = 0;

  /** Walk one code until `ceiling` total opportunities are held, or it runs dry. */
  async function walk(ncode: string | undefined, ceiling: number): Promise<void> {
    if (exhausted.has(ncode)) return;
    const key = ncode ?? "(any)";
    let offset = offsets.get(ncode) ?? 0;

    while ((pagesUsed.get(ncode) ?? 0) < SAM_MAX_PAGES) {
      if (opportunities.length >= ceiling) break;
      pagesUsed.set(ncode, (pagesUsed.get(ncode) ?? 0) + 1);

      // Ask for no more than we can keep, except when an agency filter is on:
      // that one is applied client-side, so a tight page would mostly be discarded.
      const pageSize = hasAgencyFilter
        ? SAM_PAGE_SIZE
        : Math.min(SAM_PAGE_SIZE, ceiling - opportunities.length);

      const raw = await fetchPage({ ...(ncode ? { ncode } : {}), offset, pageSize });
      requests++;

      const rows = raw.opportunitiesData ?? [];
      // totalRecords describes the whole match set, not the page, so take it once.
      if (!(key in matchedByNaics)) matchedByNaics[key] = raw.totalRecords ?? rows.length;
      fetched += rows.length;

      for (const row of rows) {
        if (opportunities.length >= ceiling) break;
        const opp = normalise(row);
        // SAM can repeat a notice across pages when the corpus shifts mid-walk.
        if (!opp.noticeId || seen.has(opp.noticeId)) continue;
        if (hasAgencyFilter && !matchesAgency(row, input.agencies!)) continue;
        seen.add(opp.noticeId);
        opportunities.push(opp);
      }

      offset += rows.length;
      offsets.set(ncode, offset);
      // Short page or nothing left to walk: this code is exhausted.
      if (rows.length < pageSize || offset >= (raw.totalRecords ?? 0)) {
        exhausted.add(ncode);
        break;
      }
    }
  }

  // Pass 1: equal shares.
  for (const ncode of codes) {
    await walk(ncode, Math.min(input.limit, opportunities.length + perCode));
  }

  // Pass 2: spend what pass 1 left over, on whatever still has matches. Repeats
  // while progress is being made, so leftover capacity can move more than once.
  while (opportunities.length < input.limit) {
    const before = opportunities.length;
    for (const ncode of codes) {
      if (opportunities.length >= input.limit) break;
      await walk(ncode, input.limit);
    }
    if (opportunities.length === before) break;
  }

  const totalRecords = Object.values(matchedByNaics).reduce((a, b) => a + b, 0);
  return { totalRecords, matchedByNaics, fetched, requests, truncated: fetched < totalRecords, opportunities };
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export const samGovOpportunitySearch = defineTool({
  name: "samGovOpportunitySearch",
  inputSchema: samSearchInputSchema,
  outputSchema: samSearchOutputSchema,
  async run(ctx, input) {
    return collectSamOpportunities(input, async (page) => {
      // Budget is claimed per request, not per search: a paged sweep really does
      // spend one call per page against SAM's daily allowance.
      if (!(await claimBudget(ctx.env, "sam_gov", DAILY_BUDGET.sam_gov))) {
        throw new Error(`SAM.gov daily budget reached (${DAILY_BUDGET.sam_gov}/day). Try again tomorrow or raise the cap in DAILY_BUDGET.`);
      }
      return callJson<RawSamResponse>(
        ctx.fetch,
        buildSamSearchUrl(ctx.env.SAM_GOV_API_KEY, input, page),
        { headers: { Accept: "application/json" } },
        { label: "SAM.gov API" },
      );
    });
  },
});
