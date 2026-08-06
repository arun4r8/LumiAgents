import { createClient } from "@/lib/supabase/server";
import { OpportunitiesClient, type Opportunity } from "@/components/opportunities-client";

export const dynamic = "force-dynamic";

/**
 * Opportunities tab — public.opportunities, the GovCon BD pipeline. Read through
 * the RLS-scoped server client (opportunities are permission-sensitive; no admin
 * client here). This rendering moved out of /records/data's "govcon" tab.
 */
export async function OpportunitiesTab() {
  const supabase = await createClient();

  const { data } = await supabase
    .from("opportunities")
    .select(
      "id, title, agency, set_aside, fit_score, fit_reason, red_flags, recommendation, response_deadline, status, solicitation_number, naics_code, last_scored_at",
    )
    .order("fit_score", { ascending: false, nullsFirst: false })
    .order("last_scored_at", { ascending: false, nullsFirst: false })
    .limit(200);

  return <OpportunitiesClient opportunities={(data ?? []) as Opportunity[]} />;
}
