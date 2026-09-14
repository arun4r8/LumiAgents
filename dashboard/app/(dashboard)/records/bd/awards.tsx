import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { AwardsClient } from "@/components/awards-client";
import { SubscriptionsClient, type Subscription } from "@/components/subscriptions-client";
import { createSubscription, updateSubscription, toggleSubscription, deleteSubscription, sendNow } from "../../subscriptions/actions";

const EMAIL_CONFIGURED = process.env.NEXT_PUBLIC_EMAIL_CONFIGURED === "true";

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
  cycle_status: string | null;
  last_scored_at: string;
}

// Renamed from OpportunitiesTab: this component queries `.from("awards")` and
// renders AwardsClient, so the name now matches what it actually shows. The real
// Opportunities tab (public.opportunities) lives in ./opportunities.tsx.
export async function AwardsTab() {
  const supabase = await createClient();

  const { data } = await supabase
    .from("awards")
    .select("*")
    .order("fit_score", { ascending: false, nullsFirst: false })
    .order("last_scored_at", { ascending: false });

  const { data: awardSubs } = await supabase
    .schema("orchestration")
    .from("subscriptions")
    .select("*")
    // Digests only: the 'alert' row is not editable here (#233).
    .in("kind", ["opportunity", "award"])
    .order("created_at", { ascending: true });

  // Dismiss = remove from the radar. Safe: the award_scored ledger keeps the sweep
  // from re-adding it unless its content changes.
  async function dismissAward(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const id = formData.get("id") as string;
    const { error } = await supabase.from("awards").delete().eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/records/bd");
  }

  return (
    <>
      <AwardsClient awards={(data ?? []) as Award[]} dismissAward={dismissAward} />
      <div className="page" style={{ paddingTop: 0 }}>
        <div style={{ paddingTop: 24, borderTop: "1px solid var(--line)" }}>
          <SubscriptionsClient
            subscriptions={(awardSubs ?? []) as Subscription[]}
            lockedKind="award"
            title="Award Digest Subscriptions"
            intro="Email the award digest (industry recognition + government small business awards) to recipients on a cadence. Manage all subscriptions together under Settings → Subscriptions."
            emailConfigured={EMAIL_CONFIGURED}
            embedded
            createSubscription={createSubscription}
            toggleSubscription={toggleSubscription}
            deleteSubscription={deleteSubscription}
            updateSubscription={updateSubscription}
            sendNow={sendNow}
          />
        </div>
      </div>
    </>
  );
}
