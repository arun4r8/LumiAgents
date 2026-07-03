import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { AwardsClient } from "@/components/awards-client";

export const dynamic = "force-dynamic";

export interface Award {
  id: string;
  award_id: string;
  title: string;
  sponsor: string | null;
  category: string | null;
  award_type: string;
  application_deadline: string | null;
  nomination_deadline: string | null;
  source_url: string | null;
  fit_score: number | null;
  fit_reason: string | null;
  prestige: string | null;
  effort: string | null;
  recommendation: string;
  last_scored_at: string;
}

export default async function AwardsPage() {
  const supabase = await createClient();

  const { data } = await supabase
    .from("awards")
    .select("*")
    .order("fit_score", { ascending: false, nullsFirst: false })
    .order("last_scored_at", { ascending: false });

  // Dismiss = remove from the radar. Safe: the award_scored ledger keeps the sweep
  // from re-adding it unless its content changes.
  async function dismissAward(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const id = formData.get("id") as string;
    const { error } = await supabase.from("awards").delete().eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/awards");
  }

  return <AwardsClient awards={(data ?? []) as Award[]} dismissAward={dismissAward} />;
}
