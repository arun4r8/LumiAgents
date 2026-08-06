import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { ApprovalsClient, type ApprovalItem } from "@/components/approvals-client";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();

  const { data: approvals } = await supabase
    .schema("orchestration")
    .from("approvals")
    .select(`id, prompt, status, created_at, expires_at, decided_at, decided_by, decision_notes, run_id, run_step_id, runs(id, orchestrations(name))`)
    .order("created_at", { ascending: false })
    .limit(100);

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

  return (
    <ApprovalsClient
      pending={pending}
      decided={decided}
      me={user?.email ?? "you"}
      decide={decide}
    />
  );
}
