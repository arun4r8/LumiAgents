import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { ApprovalsClient, type ApprovalItem, type ApprovalStats } from "@/components/approvals-client";
import { fetchRuntime } from "@/lib/runtime-fetch";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

export default async function ApprovalsPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();

  // One RLS-scoped round trip — approvals are permission-sensitive, so no
  // admin/service-role client here. We fetch the most recent approvals (raised
  // from the old limit of 100 to 500) and derive both views in code: the pending
  // LIST is every pending row returned, and the 30-day stat band is windowed by
  // created_at below. Deliberately NOT filtering server-side by a timestamp — a
  // fragile filter on this query is not worth risking the pending list, the one
  // thing on this page with real side effects.
  // Server Component: renders once, on the server, with no client render to disagree
  // with. The rule cannot tell an RSC from a client render; the equivalent call in a
  // client component WOULD be a bug, which is why records/bd/industry-days.tsx passes
  // its cutoff down as a prop instead of computing one here.
  // eslint-disable-next-line react-hooks/purity
  const cutoffIso = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

  const { data: approvals } = await supabase
    .schema("orchestration")
    .from("approvals")
    .select(`id, prompt, status, created_at, expires_at, decided_at, decided_by, decision_notes, run_id, run_step_id, runs(id, orchestrations(name))`)
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

    const res = await fetchRuntime(`/api/approvals/${approvalId}/respond`, {
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
    // The run behind this request, so a card can link to what it's approving.
    // Prefer the joined run id; fall back to the raw run_id column.
    runId: a.runs?.id ?? a.run_id ?? null,
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
