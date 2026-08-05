import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SettingsClient, type TeamMember } from "@/components/settings-client";
import { type Subscription } from "@/components/subscriptions-client";
import { roleOf } from "@/lib/role";
import { updateAgentConfig, updateOrchestrationConfig } from "./actions";
import { inviteMember, revokeMember, resendInvite } from "./team-actions";
import {
  createSubscription, updateSubscription, toggleSubscription, deleteSubscription, sendNow,
} from "../subscriptions/actions";

export const dynamic = "force-dynamic";

const EMAIL_CONFIGURED = process.env.NEXT_PUBLIC_EMAIL_CONFIGURED === "true";

const SUBSCRIPTIONS_INTRO =
  "All email digests in one place. Opportunity digests (Beady) and award digests (Cleo) are managed here " +
  "together, and award digests can also be managed in context at the bottom of the BD Pipeline page. Each " +
  "subscription receives everything scoring at or above its minimum fit score that matches its filters; for " +
  "opportunities the threshold sets the range, where 7+ is pursue-grade only and 5–6 also includes " +
  "monitor-grade leads. A daily driver runs at 13:00 UTC: daily subscriptions send every run, weekly ones " +
  "once every 7 days. Use Send now to dispatch the full current digest immediately.";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; kind?: string }>;
}) {
  const { tab, kind } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // One source of truth for role — see lib/role.ts. Previously this file read
  // `user?.app_metadata?.role === "ops"` directly, which missed the user_role
  // claim fallback the sidebar gating uses.
  const isOps = roleOf(user) === "ops";

  const [agentConfigsRes, orchestrationsRes, subscriptionsRes] = await Promise.all([
    supabase.schema("orchestration").from("agent_configs")
      .select("agent_id, model, max_tokens, notes, updated_at"),
    supabase.schema("orchestration").from("orchestrations")
      .select("id, name, version, description, is_active, cron, model, notes")
      .order("name"),
    // Subscriptions folded under Settings as a tab in the redesign; /subscriptions
    // 308s here. Endusers never see the tab, so only fetch for ops.
    isOps
      ? supabase.schema("orchestration").from("subscriptions")
          .select("*").order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as Subscription[] }),
  ]);

  // Only ops may enumerate members (uses the service-role admin client). Degrade
  // gracefully if the service-role secret isn't provisioned yet, so the Settings
  // page still renders (the Team tab just shows no members until it's set).
  let members: TeamMember[] = [];
  if (isOps) {
    try {
      const { data: listed } = await createAdminClient().auth.admin.listUsers();
      members = (listed?.users ?? []).map((u) => ({
        id: u.id,
        email: u.email ?? "—",
        role: (u.app_metadata?.role as string) ?? "—",
        // "active" means the person has actually signed in. Do NOT use
        // email_confirmed_at: generateLink({type:"invite"}) stamps that the moment
        // the link is CREATED, so an invitee who has never opened it still looked
        // "active" — which also meant the Resend button never appeared for anyone.
        status: u.last_sign_in_at ? "active" : "invited",
        created_at: u.created_at,
      }));
    } catch (err) {
      console.error("[settings] member list unavailable:", err);
    }
  }

  return (
    <SettingsClient
      userId={user?.id ?? ""}
      userEmail={user?.email ?? ""}
      userCreatedAt={user?.created_at ?? null}
      isOps={isOps}
      initialTab={tab}
      members={members}
      agentConfigs={(agentConfigsRes.data ?? []) as Array<{
        agent_id: string; model: string; max_tokens: number; notes: string | null; updated_at: string;
      }>}
      orchestrations={(orchestrationsRes.data ?? []) as Array<{
        id: string; name: string; version: number; description: string | null;
        is_active: boolean; cron: string | null; model: string | null; notes: string | null;
      }>}
      subscriptions={(subscriptionsRes.data ?? []) as Subscription[]}
      subscriptionsIntro={SUBSCRIPTIONS_INTRO}
      subscriptionsInitialKind={kind === "opportunity" || kind === "award" ? kind : "all"}
      emailConfigured={EMAIL_CONFIGURED}
      updateAgentConfig={updateAgentConfig}
      updateOrchestrationConfig={updateOrchestrationConfig}
      inviteMember={inviteMember}
      revokeMember={revokeMember}
      resendInvite={resendInvite}
      createSubscription={createSubscription}
      updateSubscription={updateSubscription}
      toggleSubscription={toggleSubscription}
      deleteSubscription={deleteSubscription}
      sendNow={sendNow}
    />
  );
}
