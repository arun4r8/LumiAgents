import { createClient } from "@/lib/supabase/server";
import { OpportunitiesClient, type Opportunity } from "@/components/opportunities-client";

export const dynamic = "force-dynamic";

/**
 * Opportunities tab — public.opportunities, the GovCon BD pipeline. Read through
 * the RLS-scoped server client (opportunities are permission-sensitive; no admin
 * client here). This rendering moved out of /records/data's "govcon" tab.
 */

/**
 * Deadline filter (Tommy: "current / historical deals").
 *
 * `status` cannot answer that question: every row in production is 'open' because
 * nothing ever transitions it — closing the loop is the Go/No-go and award-tracking
 * work in #174. Until then `response_deadline` is the only real signal, and it is a
 * decisive one: 109 of 139 rows have a deadline in the past.
 *
 * Filtering happens in the QUERY, not in the client. The page is capped and ordered by
 * fit, so a client-side filter would only filter the rows that survived the cap, and
 * the header counts would describe the wrong set.
 *
 * Default is `open`, because this is a go/no-go screen and you cannot pursue a
 * solicitation whose deadline has passed. The header always states which filter is
 * active and the full total, so a narrowed view never reads as missing data.
 */
export type DeadlineFilter = "open" | "past" | "all";

export function deadlineFrom(raw: string | undefined): DeadlineFilter {
  return raw === "past" || raw === "all" ? raw : "open";
}

/**
 * The page is a go/no-go screen, so the order is fit-first and the page is
 * capped. That cap is fine; being quiet about it is not. Sorting by fit puts
 * unscored rows (fit_score null) last, so past the cap a freshly swept notice
 * falls off the end and the screen looks complete. The two head counts below
 * are what let the header say "the top 200 of 512" instead of implying 200 is
 * everything. They are `head: true`, so they cost a count and no rows.
 */
const PAGE_LIMIT = 200;

export async function OpportunitiesTab({ deadline = "open" }: { deadline?: DeadlineFilter }) {
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);

  // A row with no deadline is kept in the "open" view: unknown is not the same as
  // expired, and dropping it would hide a freshly swept notice that has not been
  // parsed yet — the same failure the page cap comment above warns about.
  interface DeadlineFilterable<T> {
    or(filter: string): T;
    lt(column: string, value: string): T;
  }
  const applyDeadline = <T extends DeadlineFilterable<T>>(q: T): T => {
    if (deadline === "open") return q.or(`response_deadline.gte.${today},response_deadline.is.null`);
    if (deadline === "past") return q.lt("response_deadline", today);
    return q;
  };

  const [rowsRes, totalRes, scoredRes, openRes, pastRes] = await Promise.all([
    applyDeadline(
      supabase
        .from("opportunities")
        .select(
          "id, title, agency, set_aside, fit_score, fit_reason, red_flags, recommendation, response_deadline, status, solicitation_number, naics_code, last_scored_at",
        ),
    )
      .order("fit_score", { ascending: false, nullsFirst: false })
      .order("last_scored_at", { ascending: false, nullsFirst: false })
      .limit(PAGE_LIMIT),
    supabase.from("opportunities").select("id", { count: "exact", head: true }),
    // Counted server-side rather than derived from the returned page: once the
    // page is capped, the rows in hand are the highest-scoring ones, so counting
    // them would report the cap rather than how many are actually scored.
    applyDeadline(
      supabase.from("opportunities").select("id", { count: "exact", head: true }),
    ).not("fit_score", "is", null),
    // Both bucket counts, so the filter control can show its own sizes without a
    // second round trip and without inferring them from the page in hand.
    supabase
      .from("opportunities")
      .select("id", { count: "exact", head: true })
      .or(`response_deadline.gte.${today},response_deadline.is.null`),
    supabase
      .from("opportunities")
      .select("id", { count: "exact", head: true })
      .lt("response_deadline", today),
  ]);

  const rows = (rowsRes.data ?? []) as Opportunity[];

  return (
    <OpportunitiesClient
      opportunities={rows}
      // Fall back to what is in hand if the count query failed, so a missing
      // count degrades to the old behaviour instead of rendering "of 0".
      total={totalRes.count ?? rows.length}
      scoredTotal={scoredRes.count ?? rows.filter((o) => o.fit_score != null).length}
      limit={PAGE_LIMIT}
      deadline={deadline}
      openCount={openRes.count ?? 0}
      pastCount={pastRes.count ?? 0}
    />
  );
}
