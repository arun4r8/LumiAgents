import { createClient } from "@/lib/supabase/server";
import { SettingsClient } from "@/components/settings-client";
import { updateAgentConfig, updateOrchestrationConfig } from "./actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const [agentConfigsRes, orchestrationsRes] = await Promise.all([
    supabase.schema("orchestration").from("agent_configs")
      .select("agent_id, model, max_tokens, notes, updated_at"),
    supabase.schema("orchestration").from("orchestrations")
      .select("id, name, version, description, is_active, cron, model, notes")
      .order("name"),
  ]);

  return (
    <SettingsClient
      userEmail={user?.email ?? ""}
      userCreatedAt={user?.created_at ?? null}
      agentConfigs={(agentConfigsRes.data ?? []) as Array<{
        agent_id: string; model: string; max_tokens: number; notes: string | null; updated_at: string;
      }>}
      orchestrations={(orchestrationsRes.data ?? []) as Array<{
        id: string; name: string; version: number; description: string | null;
        is_active: boolean; cron: string | null; model: string | null; notes: string | null;
      }>}
      updateAgentConfig={updateAgentConfig}
      updateOrchestrationConfig={updateOrchestrationConfig}
    />
  );
}
