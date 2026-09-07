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
  descriptionUrl: z.string().nullable().describe("SAM's link to the notice body. In v2 the API's `description` field is a URL, NOT the text -- fetch it with the API key appended to get the body."),
  description: z.string().nullable().describe("The notice body, when it has been fetched. Null when only the link is known -- see descriptionUrl."),
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

/**
 * Records per page. Constant for the whole walk of a NAICS code, and that is not a
 * style choice: SAM's `offset` is a PAGE INDEX, not a record offset --
 *
 *   offset — "Indicates the page index. Default offset starts with 0"
 *   limit  — "Total number of records to be retrieved per page"
 *
 * so page N covers records [N * pageSize, (N+1) * pageSize). Vary the page size
 * mid-walk and the indices stop lining up with anything.
 *
 * SAM allows up to 1000. 100 is used because match sets are in the low hundreds
 * once the NAICS filter actually applies, so a bigger page buys nothing, and a
 * heavier query has already drawn a 504 from SAM's gateway once.
 */
export const SAM_PAGE_SIZE = 100;
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

/**
 * SAM v2 returns a link in `description`; other payloads occasionally return text.
 *
 * Matches the scheme, not the prefix "http". A notice body genuinely can open with
 * "http-based integration is in scope", and treating that as a link would discard
 * the one thing we are trying to keep.
 */
export function isDescriptionUrl(description?: string | null): boolean {
  return typeof description === "string" && /^https?:\/\//i.test(description);
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
    // SAM v2's `description` is a LINK to the body, not the body:
    //   "description": "https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=..."
    //   "A link to an opportunity description. Note: To download the description,
    //    user should append the public API Key."
    // It was read as prose and handed to the scoring model for every notice, so the
    // model has never seen a notice body -- it scored titles (#219). Keeping the two
    // apart means a caller cannot mistake one for the other again, and a caller that
    // has not fetched the text gets null rather than a plausible-looking string.
    descriptionUrl: isDescriptionUrl(o.description) ? o.description! : null,
    description: isDescriptionUrl(o.description) ? null : (o.description ? o.description.slice(0, 800) : null),
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
  // Next page index per code, so the second pass resumes rather than restarts, and
  // so SAM_MAX_PAGES is a budget for the whole walk of a code rather than per call.
  const pages = new Map<string | undefined, number>();
  // Records actually returned per code, for the "seen everything SAM claims" stop.
  const seenRecords = new Map<string | undefined, number>();
  // Rows fetched but not yet taken, because a pass hit its ceiling mid-page. Held
  // so the next pass can take them without paying for the page again -- and so a
  // partly-consumed page is never mistaken for an exhausted code.
  const pending = new Map<string | undefined, RawSamOpportunity[]>();
  const exhausted = new Set<string | undefined>();
  let fetched = 0;
  let requests = 0;

  /**
   * Walk one code until `ceiling` total opportunities are held, or it runs dry.
   *
   * `page` counts PAGES, not records, because that is what SAM's `offset` means.
   * The previous version advanced it by `rows.length` and shrank the page size to
   * whatever headroom was left, so the second request of a walk asked for page 63
   * of a 91-record set and got an empty page back. It read as "exhausted" and the
   * sweep quietly stopped 28 notices short of its own match set.
   */
  async function walk(ncode: string | undefined, ceiling: number): Promise<void> {
    const key = ncode ?? "(any)";

    /** Take from `pending` until it runs out or the ceiling is reached. */
    const drain = () => {
      const queue = pending.get(ncode) ?? [];
      while (queue.length > 0 && opportunities.length < ceiling) {
        const row = queue.shift()!;
        const opp = normalise(row);
        // SAM can repeat a notice across pages when the corpus shifts mid-walk.
        if (!opp.noticeId || seen.has(opp.noticeId)) continue;
        if (hasAgencyFilter && !matchesAgency(row, input.agencies!)) continue;
        seen.add(opp.noticeId);
        opportunities.push(opp);
      }
      pending.set(ncode, queue);
    };

    drain();

    while (!exhausted.has(ncode) && opportunities.length < ceiling) {
      const page = pages.get(ncode) ?? 0;
      if (page >= SAM_MAX_PAGES) break;

      const raw = await fetchPage({ ...(ncode ? { ncode } : {}), offset: page, pageSize: SAM_PAGE_SIZE });
      requests++;
      pages.set(ncode, page + 1);

      const rows = raw.opportunitiesData ?? [];
      // totalRecords describes the whole match set, not the page, so take it once.
      if (!(key in matchedByNaics)) matchedByNaics[key] = raw.totalRecords ?? rows.length;
      fetched += rows.length;
      seenRecords.set(ncode, (seenRecords.get(ncode) ?? 0) + rows.length);

      pending.set(ncode, [...(pending.get(ncode) ?? []), ...rows]);
      drain();

      // A short page is the last page; so is having seen every record SAM claims.
      // Note this marks the SOURCE exhausted, not the code: anything still in
      // `pending` is taken by a later pass without another request.
      if (rows.length < SAM_PAGE_SIZE || (seenRecords.get(ncode) ?? 0) >= (raw.totalRecords ?? 0)) {
        exhausted.add(ncode);
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
    // One budget claim for the whole walk, for the most pages it could possibly
    // make: one per NAICS code, plus enough pages to satisfy `limit`. Claiming per
    // page was accurate accounting bought with 7 subrequests of a 50-per-invocation
    // Worker budget, which is the resource that actually runs out.
    const codeCount = input.naicsCodes && input.naicsCodes.length > 0 ? input.naicsCodes.length : 1;
    const maxPages = codeCount + Math.ceil(input.limit / SAM_PAGE_SIZE);
    if (!(await claimBudget(ctx.env, "sam_gov", DAILY_BUDGET.sam_gov, maxPages))) {
      throw new Error(`SAM.gov daily budget reached (${DAILY_BUDGET.sam_gov}/day). Try again tomorrow or raise the cap in DAILY_BUDGET.`);
    }

    return collectSamOpportunities(input, async (page) => {
      return callJson<RawSamResponse>(
        ctx.fetch,
        buildSamSearchUrl(ctx.env.SAM_GOV_API_KEY, input, page),
        { headers: { Accept: "application/json" } },
        { label: "SAM.gov API" },
      );
    });
  },
});
