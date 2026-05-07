import type { RunContext } from "../types";
import { SupabaseClient } from "../db/client";

const POLL_INTERVAL_MS = 5000;
const DEFAULT_EXPIRY_HOURS = 48;

export interface ApprovalResult {
  approved: boolean;
  notes: string | null;
  decidedBy: string | null;
}

export async function await_approval(
  ctx: RunContext,
  options: {
    name: string;
    prompt: string;
    from?: { userId?: string; role?: string };
    expiresInHours?: number;
  },
): Promise<ApprovalResult> {
  const db = new SupabaseClient(ctx.env);
  const idx = ctx.stepIndex();

  const expiresAt = new Date(
    Date.now() + (options.expiresInHours ?? DEFAULT_EXPIRY_HOURS) * 60 * 60 * 1000,
  ).toISOString();

  const runStep = await db.createRunStep({
    run_id: ctx.runId,
    step_index: idx,
    step_name: options.name,
    step_type: "await_approval",
    status: "running",
    input: { prompt: options.prompt, from: options.from },
  });

  // Create the approval row — dashboard renders this in the approval inbox
  const approvalRows = await fetch(
    `${ctx.env.SUPABASE_URL}/rest/v1/orchestration.approvals`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        run_id: ctx.runId,
        run_step_id: runStep.id,
        requested_from_user_id: options.from?.userId ?? null,
        requested_from_role: options.from?.role ?? null,
        prompt: options.prompt,
        status: "pending",
        expires_at: expiresAt,
      }),
    },
  ).then((r) => r.json() as Promise<{ id: string }[]>);

  const approvalId = approvalRows[0]?.id;
  if (!approvalId) throw new Error("Failed to create approval row");

  // Poll until decided or expired
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const rows = await fetch(
      `${ctx.env.SUPABASE_URL}/rest/v1/orchestration.approvals?id=eq.${approvalId}&select=status,decision_notes,decided_by&limit=1`,
      {
        headers: {
          apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    ).then((r) => r.json() as Promise<{ status: string; decision_notes?: string; decided_by?: string }[]>);

    const row = rows[0];
    if (!row) throw new Error(`Approval ${approvalId} not found during poll`);

    if (row.status === "approved" || row.status === "rejected") {
      const result: ApprovalResult = {
        approved: row.status === "approved",
        notes: row.decision_notes ?? null,
        decidedBy: row.decided_by ?? null,
      };

      await db.updateRunStep(runStep.id, {
        status: "completed",
        output: result,
        ended_at: new Date().toISOString(),
      });

      return result;
    }

    if (row.status === "expired" || new Date() > new Date(expiresAt)) {
      await db.updateRunStep(runStep.id, {
        status: "failed",
        error: { message: "Approval expired" },
        ended_at: new Date().toISOString(),
      });
      throw new Error(`Approval for "${options.name}" expired without a decision`);
    }
  }
}
