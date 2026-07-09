import { createClient } from "@/lib/supabase/server";
import { SubscriptionsClient, type Subscription } from "@/components/subscriptions-client";
import { createSubscription, updateSubscription, toggleSubscription, deleteSubscription, sendNow } from "./actions";

export const dynamic = "force-dynamic";

const EMAIL_CONFIGURED = process.env.NEXT_PUBLIC_EMAIL_CONFIGURED === "true";

const INTRO =
  "All email digests in one place. Opportunity digests (Beady) and award digests (Cleo) are managed here " +
  "together, or from the Reports and Awards pages individually. Each subscription's cadence and fit threshold " +
  "control what it receives; Send now dispatches the current digest immediately.";

export default async function SubscriptionsPage() {
  const supabase = await createClient();
  const { data: subscriptions } = await supabase
    .schema("orchestration")
    .from("subscriptions")
    .select("*")
    .order("created_at", { ascending: true });

  return (
    <SubscriptionsClient
      subscriptions={(subscriptions ?? []) as Subscription[]}
      title="Subscriptions"
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
