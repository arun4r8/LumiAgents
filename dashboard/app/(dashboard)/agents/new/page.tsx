import { notFound } from "next/navigation";
import AgentComposer from "@/components/agent-composer";
import { createClient } from "@/lib/supabase/server";
import { roleOf } from "@/lib/role";
import { getOrchestrationOptions } from "@/lib/agent-catalog";
import { emptyManifest } from "@/lib/agent-manifest";
import { createAgent, updateAgent, setAgentLifecycle, deleteAgent } from "../actions";

export const dynamic = "force-dynamic";

// Tier 1 (#67): the "New agent" composer. Ops-only — non-ops users get a 404 (the actions
// re-check ops + RLS regardless). Config agents created here go live immediately and run
// through the runtime's inline chat path (no Worker, no deploy).

export default async function NewAgentPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  // One source of truth for role — see lib/role.ts.
  if (roleOf(user) !== "ops") notFound();

  const { data: activeRows } = await supabase.schema("orchestration")
    .from("orchestrations").select("name, is_active");
  const activeByName = new Map<string, boolean>(
    ((activeRows ?? []) as { name: string; is_active: boolean }[]).map((o) => [o.name, o.is_active]),
  );
  const orchestrations = await getOrchestrationOptions(activeByName);

  return (
    <AgentComposer
      mode="create"
      initial={emptyManifest()}
      orchestrations={orchestrations}
      createAgent={createAgent}
      updateAgent={updateAgent}
      setAgentLifecycle={setAgentLifecycle}
      deleteAgent={deleteAgent}
    />
  );
}
