import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import OverviewClient from "@/components/overview-client";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const supabase = await createClient();

  const [orchResult, runsResult, approvalsResult, stepsResult, spendResult] = await Promise.all([
    supabase
      .schema("orchestration")
      .from("orchestrations")
      .select("id, name, version, description, is_active, cron")
      .order("name"),

    supabase
      .schema("orchestration")
      .from("runs")
      .select("id, status, orchestration_id, triggered_by, created_at, started_at, ended_at, orchestrations(name)")
      .order("created_at", { ascending: false })
      .limit(100),

    supabase
      .schema("orchestration")
      .from("approvals")
      .select("id, prompt, status, created_at, expires_at, run_id, runs(id, orchestrations(name))")
      .order("created_at", { ascending: false })
      .limit(50),

    supabase
      .schema("orchestration")
      .from("run_steps")
      .select("id, step_name, step_type, status, started_at, ended_at, runs(id, orchestrations(name))")
      .order("started_at", { ascending: false })
      .limit(20),

    supabase.rpc("agent_spend", { p_days: 30 }),
  ]);

  const orchestrations = (orchResult.data ?? []) as unknown as {
    id: string;
    name: string;
    version: string | number;
    is_active: boolean;
    cron: string | null;
  }[];

  const runs = (runsResult.data ?? []) as unknown as {
    id: string;
    status: string;
    orchestration_id: string | null;
    triggered_by: string | null;
    created_at: string;
    started_at: string | null;
    ended_at: string | null;
    orchestrations: { name: string } | null;
  }[];

  const approvals = (approvalsResult.data ?? []) as unknown as {
    id: string;
    prompt: string;
    status: string;
    created_at: string;
    expires_at: string | null;
    run_id: string | null;
    runs: { id: string; orchestrations: { name: string } | null } | null;
  }[];

  const recentSteps = (stepsResult.data ?? []) as unknown as {
    id: string;
    step_name: string;
    step_type: string;
    status: string;
    started_at: string | null;
    ended_at: string | null;
    runs: { id: string; orchestrations: { name: string } | null } | null;
  }[];

  const spend = (spendResult.data ?? []) as unknown as {
    agent: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    calls: number;
  }[];

  async function decideApproval(approvalId: string, approved: boolean, notes: string) {
    "use server";

    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("No active session");

    const runtimeUrl = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

    await fetch(`${runtimeUrl}/api/approvals/${approvalId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        approved,
        ...(notes?.trim() ? { notes: notes.trim() } : {}),
      }),
    });

    revalidatePath("/overview");
    revalidatePath("/approvals");
  }

  return (
    <OverviewClient
      runs={runs}
      approvals={approvals}
      orchestrations={orchestrations}
      recentSteps={recentSteps}
      spend={spend}
      decideApproval={decideApproval}
    />
  );
}
