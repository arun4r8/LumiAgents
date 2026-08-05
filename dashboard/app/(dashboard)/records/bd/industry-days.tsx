import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { IndustryDaysClient } from "@/components/industry-days-client";

export const dynamic = "force-dynamic";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

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
    const res = await fetch(
      `${RUNTIME}/api/orchestrations/${encodeURIComponent("beady/industry-day-sweep")}/run`,
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({}) },
    );
    if (!res.ok) throw new Error(`Sweep failed (${res.status}): ${await res.text()}`);
    revalidatePath("/records/bd");
  }

  return <IndustryDaysClient events={(data ?? []) as IndustryDay[]} dismiss={dismiss} findNow={findNow} />;
}
