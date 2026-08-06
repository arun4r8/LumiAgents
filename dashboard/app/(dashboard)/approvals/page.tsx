import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { ApprovalsClient, type ApprovalItem, type ApprovalStats } from "@/components/approvals-client";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

export default async function ApprovalsPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();

  // The stat band is a rolling 30-day view, but the pending LIST must show every
  // pending item regardless of age (an old blocked run still needs a decision).
  // One round trip covers both: fetch anything still pending OR decided within the
  // window. Same RLS-scoped client as before — approvals are permission-sensitive,
  // so no admin/service-role client here.
  const cutoffIso = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

  const { data: approvals } = await supabase
    .schema("orchestration")
    .from("approvals")
    .select(`id, prompt, status, created_at, expires_at, decided_at, decided_by, decision_notes, run_id, run_step_id, runs(id, orchestrations(name))`)
    .or(`status.eq.pending,created_at.gte.${cutoffIso}`)
    .order("created_at", { ascending: false })
    .limit(500);

  async function decide(formData: FormData) {
    "use server";
    const approvalId = formData.get("approvalId") as string;
    const approved = formData.get("status") === "approved";
    const notes = formData.get("notes") as string | null;

    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("No active session");

    const runtimeUrl = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

    const res = await fetch(`${runtimeUrl}/api/approvals/${approvalId}/respond`, {
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

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Worker responded ${res.status}: ${err}`);
    }

    revalidatePath("/approvals");
    revalidatePath("/overview");
  }

  const raw = (approvals ?? []) as unknown as {
    id: string;
    prompt: string;
    status: string;
    created_at: string;
    expires_at: string | null;
    decided_at: string | null;
    decided_by: string | null;
    run_id: string | null;
    runs: { id: string; orchestrations: { name: string } | null } | null;
  }[];

  const items: ApprovalItem[] = raw.map((a) => ({
    id: a.id,
    prompt: a.prompt,
    status: a.status,
    created_at: a.created_at,
    expires_at: a.expires_at,
    decided_at: a.decided_at,
    decided_by: a.decided_by,
    orchestrationName: a.runs?.orchestrations?.name ?? null,
  }));

  const pending = items.filter((a) => a.status === "pending");
  const decided = items.filter((a) => a.status !== "pending");

  // 30-day stat inputs, all derived from the single fetch above.
  // Approval rate is approved ÷ DECIDED (never ÷ total) — a pending item has no
  // outcome yet and must not be counted as "not approved". The window is applied
  // by created_at so the same window backs total / decided / rate.
  const cutoffMs = Date.parse(cutoffIso);
  const inWindow = (iso: string) => Date.parse(iso) >= cutoffMs;
  const decided30 = decided.filter((a) => inWindow(a.created_at));
  const stats: ApprovalStats = {
    total30: items.filter((a) => inWindow(a.created_at)).length,
    decided30: decided30.length,
    approved30: decided30.filter((a) => a.status === "approved").length,
  };

  return (
    <ApprovalsClient
      pending={pending}
      decided={decided}
      me={user?.email ?? "you"}
      stats={stats}
      cutoffIso={cutoffIso}
      windowDays={WINDOW_DAYS}
      decide={decide}
    />
  );
}
