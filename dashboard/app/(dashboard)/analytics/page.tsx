import { createClient } from "@/lib/supabase/server";
import { fetchRuntime } from "@/lib/runtime-fetch";
import { AnalyticsClient, type DeliveryAnalytics } from "@/components/analytics-client";
import { buildBdAnalytics, type AnalyticsRow, type BdAnalytics } from "@/lib/bd-analytics";

export const dynamic = "force-dynamic";

/**
 * Analytics — the shape of the work, rather than the rows in it.
 *
 * Two halves, because the two questions people actually ask are "what is the BD
 * pipeline made of" and "where is delivery". Both were answerable only by hand
 * before this page: by SQL for the first, by counting cards on the GitHub board
 * for the second.
 *
 * The BD half carries one number that is more important than the rest: how much of
 * the pipeline is still scored on titles alone. Every fit score predates the notice
 * body being fetched at all (#219), and the hydrator works through the backlog a
 * few rows a day. A score on a card gives no hint of that. "141 of 192 still
 * title-only" does, and it is the difference between a number you can act on and
 * one you cannot.
 */

async function loadBd(): Promise<BdAnalytics> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("opportunities")
    .select("agency, naics_code, fit_score, disposition, response_deadline, notice_text_fetched_at")
    .limit(5000);

  return buildBdAnalytics((data ?? []) as AnalyticsRow[], Date.now());
}

async function loadDelivery(): Promise<DeliveryAnalytics | null> {
  // Best-effort. A GitHub outage or an expired token must not take the BD half of
  // this page down with it — the page renders what it has and says what it lacks.
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;
    const res = await fetchRuntime("/api/analytics/delivery", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as DeliveryAnalytics;
  } catch {
    return null;
  }
}

export default async function AnalyticsPage() {
  const [bd, delivery] = await Promise.all([loadBd(), loadDelivery()]);
  return <AnalyticsClient bd={bd} delivery={delivery} />;
}
