import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { Check } from "lucide-react";
import { ApprovalsClient } from "@/components/approvals-client";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const supabase = await createClient();

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

  const all = (approvals ?? []) as unknown as {
    id: string;
    prompt: string;
    status: string;
    created_at: string;
    expires_at: string | null;
    decided_at: string | null;
    decided_by: string | null;
    decision_notes: string | null;
    run_id: string | null;
    runs: { id: string; orchestrations: { name: string } | null } | null;
  }[];

  const pending = all.filter((a) => a.status === "pending");
  const decided = all.filter((a) => a.status !== "pending");

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Approvals</h1>
          <div className="sub">
            {pending.length === 0
              ? "Nothing waiting on you."
              : `${pending.length} ${pending.length === 1 ? "decision" : "decisions"} blocking active runs.`}
          </div>
        </div>
      </div>

      {pending.length === 0 ? (
        <div className="empty">
          <div className="ico"><Check /></div>
          <h4>All clear.</h4>
          <p>No approvals pending. New requests will appear here in real time.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--gap)" }}>
          {[...pending]
            .sort((a, b) => {
              const ta = a.expires_at ? new Date(a.expires_at).getTime() : Infinity;
              const tb = b.expires_at ? new Date(b.expires_at).getTime() : Infinity;
              return ta - tb;
            })
            .map((a) => (
              <ApprovalCard key={a.id} approval={a} decide={decide} />
            ))}
        </div>
      )}

      {decided.length > 0 && <ApprovalsClient decided={decided} />}
    </div>
  );
}

// ── Approval card (renders the form, uses server action) ──────────────

function ApprovalCard({
  approval,
  decide,
}: {
  approval: {
    id: string;
    prompt: string;
    status: string;
    created_at: string;
    expires_at: string | null;
    run_id: string | null;
    runs: { id: string; orchestrations: { name: string } | null } | null;
  };
  decide: (formData: FormData) => Promise<void>;
}) {
  const orchName = approval.runs?.orchestrations?.name ?? "-";
  const expiresMs = approval.expires_at
    ? new Date(approval.expires_at).getTime() - Date.now()
    : null;
  const expiring = expiresMs != null && expiresMs < 30 * 60_000;
  const urgent = expiresMs != null && expiresMs < 2 * 60 * 60_000;

  function expiryLabel(): string {
    if (!approval.expires_at) return "";
    const ms = new Date(approval.expires_at).getTime() - Date.now();
    if (ms < 0) return "Expired";
    const m = Math.floor(ms / 60_000);
    if (m < 60) return `Expires in ${m}m`;
    return `Expires in ${Math.floor(m / 60)}h`;
  }

  return (
    <div className={`ap-card${expiring ? " expiring" : urgent ? " urgent" : ""}`}>
      <div className="ah">
        <div className="meta">
          <div className="name">{orchName}</div>
          <div className="sub">
            <span>
              requested{" "}
              <b>{timeAgo(approval.created_at)}</b>
            </span>
            {expiresMs != null && (
              <span style={{ color: expiring ? "var(--err)" : urgent ? "var(--warn)" : "var(--ink-2)" }}>
                {expiryLabel()}
              </span>
            )}
          </div>
        </div>
        <div className="row gap-sm">
          {expiring && (
            <span className="chip err">Expires soon</span>
          )}
          {approval.run_id && (
            <a href={`/runs/${approval.run_id}`} className="btn ghost sm">
              View run →
            </a>
          )}
        </div>
      </div>

      <div className="prompt">{approval.prompt}</div>

      <form action={decide} className="actions">
        <input type="hidden" name="approvalId" value={approval.id} />
        <textarea name="notes" className="input" placeholder="Notes (optional)…" />
        <button name="status" value="approved" type="submit" className="btn success">
          ✓ Approve
        </button>
        <button name="status" value="rejected" type="submit" className="btn danger-out">
          ✕ Reject
        </button>
      </form>
    </div>
  );
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
