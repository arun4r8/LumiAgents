import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
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

/**
 * Human triage (BD syncup 2026-09-01): Pursue / Watch / Ignore.
 *
 * `ignore` is a soft hide, so the default list excludes it rather than deleting the
 * row -- a mis-click has to be recoverable, and an ignored opportunity is still
 * evidence about what the sweep surfaces. `showIgnored` is what lets a human go back
 * and find one.
 */
export type Disposition = "pursue" | "watch" | "ignore";

export function isDisposition(v: unknown): v is Disposition {
  return v === "pursue" || v === "watch" || v === "ignore";
}

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

export async function OpportunitiesTab({
  deadline = "open",
  showIgnored = false,
}: { deadline?: DeadlineFilter; showIgnored?: boolean }) {
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);

  /**
   * Record a human decision on an opportunity.
   *
   * Writes through the RLS-scoped client, not the admin client: whoever can see the
   * row is who may triage it, and that is a decision the database should enforce
   * rather than this action. Passing the same value again clears it, so the buttons
   * toggle and a mis-click is undone by clicking the same button.
   */
  async function setDisposition(formData: FormData) {
    "use server";
    const id = String(formData.get("id") ?? "");
    const raw = String(formData.get("disposition") ?? "");
    if (!id || !isDisposition(raw)) throw new Error("setDisposition: bad input");

    const sb = await createClient();
    const { data: { user } } = await sb.auth.getUser();

    const { data: current } = await sb
      .from("opportunities").select("disposition, pipeline_stage").eq("id", id).single();
    const next = current?.disposition === raw ? null : raw;

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      disposition: next,
      disposition_at: next ? now : null,
      disposition_by: next ? (user?.id ?? null) : null,
    };

    // Marking Pursue puts the card on the board, in the first column. Done here rather
    // than left to the board's null-means-first-stage fallback so that
    // `pipeline_stage_at` is real from the outset -- the board sorts stalled cards to
    // the top, and a card that has never carried a timestamp cannot go stale.
    if (next === "pursue" && !current?.pipeline_stage) {
      patch["pipeline_stage"] = "response_outline";
      patch["pipeline_stage_at"] = now;
    }

    const { error } = await sb.from("opportunities").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/records/bd");
  }

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

  // "Ignore removes from list" -- as a filter, not a delete.
  const applyIgnored = <T extends { or(f: string): T }>(q: T): T =>
    showIgnored ? q : q.or("disposition.is.null,disposition.neq.ignore");

  const [rowsRes, totalRes, scoredRes, openRes, pastRes, ignoredRes] = await Promise.all([
    applyIgnored(applyDeadline(
      supabase
        .from("opportunities")
        .select(
          "id, title, agency, set_aside, fit_score, fit_reason, red_flags, recommendation, response_deadline, status, solicitation_number, naics_code, last_scored_at, source_url, disposition",
        ),
    ))
      .order("fit_score", { ascending: false, nullsFirst: false })
      .order("last_scored_at", { ascending: false, nullsFirst: false })
      .limit(PAGE_LIMIT),
    supabase.from("opportunities").select("id", { count: "exact", head: true }),
    // Counted server-side rather than derived from the returned page: once the
    // page is capped, the rows in hand are the highest-scoring ones, so counting
    // them would report the cap rather than how many are actually scored.
    applyIgnored(applyDeadline(
      supabase.from("opportunities").select("id", { count: "exact", head: true }),
    )).not("fit_score", "is", null),
    // Both bucket counts, so the filter control can show its own sizes without a
    // second round trip and without inferring them from the page in hand.
    applyIgnored(
      supabase
        .from("opportunities")
        .select("id", { count: "exact", head: true })
        .or(`response_deadline.gte.${today},response_deadline.is.null`),
    ),
    applyIgnored(
      supabase
        .from("opportunities")
        .select("id", { count: "exact", head: true })
        .lt("response_deadline", today),
    ),
    // Counted regardless of the ignore filter -- it is what the "show ignored"
    // affordance reports, so it must describe the rows currently being hidden.
    supabase
      .from("opportunities")
      .select("id", { count: "exact", head: true })
      .eq("disposition", "ignore"),
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
      ignoredCount={ignoredRes.count ?? 0}
      showIgnored={showIgnored}
      setDisposition={setDisposition}
    />
  );
}
