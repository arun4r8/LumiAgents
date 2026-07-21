import { createClient } from "@/lib/supabase/server";
import { SubscriptionsClient, type Subscription, type SubscriptionKind } from "@/components/subscriptions-client";
import { createSubscription, updateSubscription, toggleSubscription, deleteSubscription, sendNow } from "./actions";

export const dynamic = "force-dynamic";

const EMAIL_CONFIGURED = process.env.NEXT_PUBLIC_EMAIL_CONFIGURED === "true";

const INTRO =
  "All email digests in one place. Opportunity digests (Beady) and award digests (Cleo) are managed here " +
  "together, and award digests can also be managed in context at the bottom of the Awards page. Each " +
  "subscription receives everything scoring at or above its minimum fit score that matches its filters; for " +
  "opportunities the threshold sets the range, where 7+ is pursue-grade only and 5–6 also includes " +
  "monitor-grade leads. A daily driver runs at 13:00 UTC: daily subscriptions send every run, weekly ones " +
  "once every 7 days. Use Send now to dispatch the full current digest immediately.";

// ?kind= preselects a tab, so the /reports redirect still lands on opportunity digests.
function initialTabFrom(raw: string | undefined): SubscriptionKind | "all" {
  return raw === "opportunity" || raw === "award" ? raw : "all";
}

export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { kind } = await searchParams;
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
      initialTab={initialTabFrom(kind)}
      emailConfigured={EMAIL_CONFIGURED}
      createSubscription={createSubscription}
      toggleSubscription={toggleSubscription}
      deleteSubscription={deleteSubscription}
      updateSubscription={updateSubscription}
      sendNow={sendNow}
    />
  );
}
