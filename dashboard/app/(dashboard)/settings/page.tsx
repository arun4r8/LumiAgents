import { createClient } from "@/lib/supabase/server";
import { SettingsClient } from "@/components/settings-client";
import { updateAgentConfig, updateOrchestrationConfig } from "./actions";

export const dynamic = "force-dynamic";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

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

  async function triggerVaultSync(formData: FormData) {
    "use server";
    const sb = await createClient();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error("No active session");

    const repoOwner = (formData.get("repoOwner") as string)?.trim();
    const repoName = (formData.get("repoName") as string)?.trim();
    const branch = (formData.get("branch") as string)?.trim() || undefined;

    if (!repoOwner || !repoName) throw new Error("repoOwner and repoName are required");

    const res = await fetch(`${RUNTIME}/api/vault/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ repoOwner, repoName, ...(branch ? { branch } : {}) }),
    });
    if (!res.ok) throw new Error(await res.text());
  }

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
      triggerVaultSync={triggerVaultSync}
    />
  );
}
