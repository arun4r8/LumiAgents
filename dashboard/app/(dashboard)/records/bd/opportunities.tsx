import { createClient } from "@/lib/supabase/server";
import { OpportunitiesClient, type Opportunity } from "@/components/opportunities-client";

export const dynamic = "force-dynamic";

/**
 * Opportunities tab — public.opportunities, the GovCon BD pipeline. Read through
 * the RLS-scoped server client (opportunities are permission-sensitive; no admin
 * client here). This rendering moved out of /records/data's "govcon" tab.
 */

/**
 * The page is a go/no-go screen, so the order is fit-first and the page is
 * capped. That cap is fine; being quiet about it is not. Sorting by fit puts
 * unscored rows (fit_score null) last, so past the cap a freshly swept notice
 * falls off the end and the screen looks complete. The two head counts below
 * are what let the header say "the top 200 of 512" instead of implying 200 is
 * everything. They are `head: true`, so they cost a count and no rows.
 */
const PAGE_LIMIT = 200;

export async function OpportunitiesTab() {
  const supabase = await createClient();

  const [rowsRes, totalRes, scoredRes] = await Promise.all([
    supabase
      .from("opportunities")
      .select(
        "id, title, agency, set_aside, fit_score, fit_reason, red_flags, recommendation, response_deadline, status, solicitation_number, naics_code, last_scored_at",
      )
      .order("fit_score", { ascending: false, nullsFirst: false })
      .order("last_scored_at", { ascending: false, nullsFirst: false })
      .limit(PAGE_LIMIT),
    supabase.from("opportunities").select("id", { count: "exact", head: true }),
    // Counted server-side rather than derived from the returned page: once the
    // page is capped, the rows in hand are the highest-scoring ones, so counting
    // them would report the cap rather than how many are actually scored.
    supabase
      .from("opportunities")
      .select("id", { count: "exact", head: true })
      .not("fit_score", "is", null),
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
    />
  );
}
