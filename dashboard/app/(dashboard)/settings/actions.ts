"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function updateAgentConfig(
  agentId: string,
  data: { model: string; max_tokens: number; notes: string | null },
): Promise<void> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  await sb.schema("orchestration").from("agent_configs").upsert({
    agent_id: agentId,
    model: data.model,
    max_tokens: data.max_tokens,
    notes: data.notes ?? null,
    updated_at: new Date().toISOString(),
    updated_by: user?.id ?? null,
  });
  revalidatePath("/settings");
}

export async function updateOrchestrationConfig(
  id: string,
  data: {
    description: string | null;
    model: string | null;
    notes: string | null;
    cron: string | null;
  },
): Promise<void> {
  const sb = await createClient();
  await sb.schema("orchestration").from("orchestrations").update({
    description: data.description ?? null,
    model: data.model || null,
    notes: data.notes ?? null,
    cron: data.cron || null,
  }).eq("id", id);
  revalidatePath("/settings");
  revalidatePath("/orchestrations");
}
