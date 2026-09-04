import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { IndustryDaysClient } from "@/components/industry-days-client";
import { fetchRuntime } from "@/lib/runtime-fetch";

export const dynamic = "force-dynamic";


export interface IndustryDay {
  id: string;
  title: string;
  agency: string | null;
  event_date: string | null;
  location: string | null;
  format: string | null;
  registration_url: string | null;
  source: "sam_gov" | "web";
  source_url: string | null;
  description: string | null;
  fit_score: number | null;
  fit_reason: string | null;
  recommendation: "attend" | "consider" | "skip";
}

async function getToken(): Promise<string> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("No active session");
  return session.access_token;
}

export async function IndustryDaysTab() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("industry_days")
    .select("*")
    .order("event_date", { ascending: true, nullsFirst: false })
    .order("fit_score", { ascending: false, nullsFirst: false });

  // Dismiss = remove from the radar. The dedup ledger keeps the sweep from re-adding
  // it unless its content changes.
  async function dismiss(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const id = formData.get("id") as string;
    const { error } = await supabase.from("industry_days").delete().eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/records/bd");
  }

  // Find now: fire beady/industry-day-sweep (async); results land here.
  async function findNow(): Promise<void> {
    "use server";
    const token = await getToken();
    const res = await fetchRuntime(`/api/orchestrations/${encodeURIComponent("beady/industry-day-sweep")}/run`,
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({}) },
    );
    if (!res.ok) throw new Error(`Sweep failed (${res.status}): ${await res.text()}`);
    revalidatePath("/records/bd");
  }

  // Computed here, on the server, and passed down rather than derived inside the
  // client component. A client deriving it from its own Date.now() gets a value a
  // few ms off the server's, so an event sitting on the boundary is filtered out of
  // one render and into the other -- the list changes length between SSR and
  // hydration and React discards the subtree (the #148/#149 failure mode). Passing
  // the instant down makes both renders agree by construction.
  // eslint-disable-next-line react-hooks/purity
  const cutoffMs = Date.now() - 86_400_000;

  return <IndustryDaysClient events={(data ?? []) as IndustryDay[]} cutoffMs={cutoffMs} dismiss={dismiss} findNow={findNow} />;
}
