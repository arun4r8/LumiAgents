import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SettingsClient, type TeamMember } from "@/components/settings-client";
import { updateAgentConfig, updateOrchestrationConfig } from "./actions";
import { inviteMember, revokeMember, resendInvite } from "./team-actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const isOps = user?.app_metadata?.role === "ops";

  const [agentConfigsRes, orchestrationsRes] = await Promise.all([
    supabase.schema("orchestration").from("agent_configs")
      .select("agent_id, model, max_tokens, notes, updated_at"),
    supabase.schema("orchestration").from("orchestrations")
      .select("id, name, version, description, is_active, cron, model, notes")
      .order("name"),
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
        status: u.email_confirmed_at ? "active" : "invited",
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
      members={members}
      agentConfigs={(agentConfigsRes.data ?? []) as Array<{
        agent_id: string; model: string; max_tokens: number; notes: string | null; updated_at: string;
      }>}
      orchestrations={(orchestrationsRes.data ?? []) as Array<{
        id: string; name: string; version: number; description: string | null;
        is_active: boolean; cron: string | null; model: string | null; notes: string | null;
      }>}
      updateAgentConfig={updateAgentConfig}
      updateOrchestrationConfig={updateOrchestrationConfig}
      inviteMember={inviteMember}
      revokeMember={revokeMember}
      resendInvite={resendInvite}
    />
  );
}
