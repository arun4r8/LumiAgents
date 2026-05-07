import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();

  const { data: approvals } = await supabase
    .schema("orchestration")
    .from("approvals")
    .select(`*, runs ( orchestrations ( name ) )`)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-sm text-gray-500 mt-1">Pending decisions that are blocking runs</p>
      </div>

      {(approvals ?? []).length === 0 ? (
        <div className="bg-white rounded-xl border p-8 text-center text-gray-400 text-sm">
          No pending approvals. All clear.
        </div>
      ) : (
        <div className="space-y-3">
          {approvals!.map((approval) => {
            const orchName = (approval.runs as { orchestrations: { name: string } | null } | null)?.orchestrations?.name;
            return (
              <div key={approval.id} className="bg-white rounded-xl border p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-full font-medium">Pending</span>
                      {orchName && <span className="text-xs text-gray-400">{orchName}</span>}
                    </div>
                    <p className="text-sm text-gray-800 mt-2">{approval.prompt}</p>
                    <p className="text-xs text-gray-400 mt-2">
                      Requested {formatDate(approval.created_at)}
                      {approval.expires_at && ` · Expires ${formatDate(approval.expires_at)}`}
                    </p>
                  </div>

                  <ApprovalActions approvalId={approval.id} userId={user?.id ?? ""} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ApprovalActions({ approvalId, userId }: { approvalId: string; userId: string }) {
  async function decide(formData: FormData) {
    "use server";
    const status = formData.get("status") as "approved" | "rejected";
    const notes = formData.get("notes") as string | null;
    const supabase = await createClient();
    await supabase
      .schema("orchestration")
      .from("approvals")
      .update({ status, decided_by: userId, decided_at: new Date().toISOString(), decision_notes: notes })
      .eq("id", approvalId);
  }

  return (
    <form action={decide} className="flex flex-col gap-2 min-w-[180px]">
      <textarea name="notes" placeholder="Notes (optional)" rows={2}
        className="px-2 py-1.5 border rounded-lg text-xs resize-none focus:outline-none focus:ring-1 focus:ring-blue-500" />
      <div className="flex gap-2">
        <button name="status" value="approved" type="submit"
          className="flex-1 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 transition-colors">
          Approve
        </button>
        <button name="status" value="rejected" type="submit"
          className="flex-1 py-1.5 bg-red-50 text-red-700 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100 transition-colors">
          Reject
        </button>
      </div>
    </form>
  );
}
