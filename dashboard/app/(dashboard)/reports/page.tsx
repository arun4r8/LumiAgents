import { createClient } from "@/lib/supabase/server";
import { SubscriptionsClient, type Subscription } from "@/components/subscriptions-client";
import { createSubscription, updateSubscription, toggleSubscription, deleteSubscription, sendNow } from "../subscriptions/actions";

export const dynamic = "force-dynamic";

const EMAIL_CONFIGURED = process.env.NEXT_PUBLIC_EMAIL_CONFIGURED === "true";

const INTRO =
  "Beady emails opportunities scoring at or above each subscription's minimum fit score (matching any " +
  "filters) to its recipients. The fit threshold sets the range: 7+ is pursue-grade only, 5–6 also " +
  "includes monitor-grade leads. A daily driver runs at 13:00 UTC — daily sends every run, weekly once " +
  "every 7 days. Use Send now to dispatch the full current digest immediately.";

export default async function ReportsPage() {
  const supabase = await createClient();
  const { data: subscriptions } = await supabase
    .schema("orchestration")
    .from("subscriptions")
    .select("*")
    .order("created_at", { ascending: true });

  return (
    <SubscriptionsClient
      subscriptions={(subscriptions ?? []) as Subscription[]}
      lockedKind="opportunity"
      title="Opportunity Reports"
      intro={INTRO}
      emailConfigured={EMAIL_CONFIGURED}
      createSubscription={createSubscription}
      toggleSubscription={toggleSubscription}
      deleteSubscription={deleteSubscription}
      updateSubscription={updateSubscription}
      sendNow={sendNow}
    />
  );
}
