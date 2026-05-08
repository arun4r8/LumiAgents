import type { RunContext } from "../types";
import { SupabaseClient } from "../db/client";
import { PauseSignal } from "./pause";

const DEFAULT_EXPIRY_HOURS = 48;
// How often the Workflow polls for a decision (seconds). 5 min keeps it responsive
// without burning too many Workflow invocations.
const WORKFLOW_POLL_INTERVAL_SEC = 300;

export interface ApprovalResult {
  approved: boolean;
  notes: string | null;
  decidedBy: string | null;
}

/**
 * Pauses the run until an ops user approves or rejects via the dashboard.
 *
 * Synchronous mode (no workflowStep):
 *   On first call: creates an approval row, throws PauseSignal.
 *   The runner catches PauseSignal, marks the run "paused", and returns 202.
 *   On resume: replay short-circuits prior steps; this function finds the
 *   decided approval row and returns the result.
 *
 * Workflow mode (ctx.workflowStep present):
 *   Creates the approval row then uses step.sleep() to poll every 5 minutes.
 *   The run stays "paused" in the DB while waiting. No PauseSignal is thrown —
 *   the Workflow is durably suspended between polls.
 */
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

  // ── Cloudflare Workflows mode ───────────────────────────────────────────────
  if (ctx.workflowStep) {
    const wf = ctx.workflowStep;

    // Create run_step + approval row once; idempotent via step.do checkpoint.
    const { runStepId } = await wf.do(`approval-${idx}-open`, async () => {
      const rs = await db.createRunStep({
        run_id: ctx.runId,
        step_index: idx,
        step_name: options.name,
        step_type: "await_approval",
        status: "running",
        input: { prompt: options.prompt, from: options.from },
      });

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
            run_step_id: rs.id,
            requested_from_user_id: options.from?.userId ?? null,
            requested_from_role: options.from?.role ?? null,
            prompt: options.prompt,
            status: "pending",
            expires_at: expiresAt,
          }),
        },
      ).then((r) => r.json() as Promise<{ id: string }[]>);

      if (!approvalRows[0]?.id) throw new Error("Failed to create approval row");

      // Mark run paused so the dashboard reflects the waiting state.
      await db.updateRun(ctx.runId, { status: "paused" });

      return { runStepId: rs.id };
    });

    // Poll until decided, expired, or max polls exhausted.
    const maxPolls = Math.ceil(
      (options.expiresInHours ?? DEFAULT_EXPIRY_HOURS) * 3600 / WORKFLOW_POLL_INTERVAL_SEC,
    );

    for (let i = 0; i < maxPolls; i++) {
      await wf.sleep(`approval-${idx}-sleep-${i}`, `${WORKFLOW_POLL_INTERVAL_SEC} seconds`);

      const decision = await wf.do(`approval-${idx}-poll-${i}`, async () => {
        const rows = await fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/orchestration.approvals?run_step_id=eq.${runStepId}&select=status,decision_notes,decided_by&limit=1`,
          {
            headers: {
              apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
            },
          },
        ).then(
          (r) =>
            r.json() as Promise<
              { status: string; decision_notes: string | null; decided_by: string | null }[]
            >,
        );
        return rows[0] ?? { status: "pending", decision_notes: null, decided_by: null };
      });

      if (decision.status === "approved" || decision.status === "rejected") {
        const result: ApprovalResult = {
          approved: decision.status === "approved",
          notes: decision.decision_notes,
          decidedBy: decision.decided_by,
        };

        await wf.do(`approval-${idx}-close`, async () => {
          await db.updateRunStep(runStepId, {
            status: "completed",
            output: result,
            ended_at: new Date().toISOString(),
          });
          // Restore run to "running" so the Workflow can continue.
          await db.updateRun(ctx.runId, { status: "running" });
        });

        return result;
      }

      if (decision.status === "expired") {
        await wf.do(`approval-${idx}-expire`, async () => {
          await db.updateRunStep(runStepId, {
            status: "failed",
            error: { message: "Approval expired" },
            ended_at: new Date().toISOString(),
          });
        });
        throw new Error(`Approval for "${options.name}" expired without a decision`);
      }

      // "pending" — continue sleeping
    }

    throw new Error(
      `Approval for "${options.name}" timed out after ${maxPolls} polls (${options.expiresInHours ?? DEFAULT_EXPIRY_HOURS}h)`,
    );
  }

  // ── Legacy synchronous mode (no Workflow binding) ─────────────────────────

  // Check if this step already has a run_step record (i.e. we're replaying)
  const existingStep = await db.getCompletedStep(ctx.runId, idx);

  if (existingStep !== null) {
    // Step was completed during a previous replay — return cached result
    return existingStep.output as ApprovalResult;
  }

  // Check if we already have a run_step row in "running" state (created on a prior pause)
  // by looking for an existing approval for this run at this step index.
  const existingApproval = await findPendingApproval(ctx, idx);

  if (existingApproval !== null) {
    // Already have an approval row — check if it's been decided
    if (existingApproval.status === "approved" || existingApproval.status === "rejected") {
      // Decision came in — mark the run_step completed and return
      await db.updateRunStep(existingApproval.runStepId, {
        status: "completed",
        output: {
          approved: existingApproval.status === "approved",
          notes: existingApproval.decision_notes,
          decidedBy: existingApproval.decided_by,
        },
        ended_at: new Date().toISOString(),
      });

      return {
        approved: existingApproval.status === "approved",
        notes: existingApproval.decision_notes,
        decidedBy: existingApproval.decided_by,
      };
    }

    if (existingApproval.status === "expired") {
      await db.updateRunStep(existingApproval.runStepId, {
        status: "failed",
        error: { message: "Approval expired" },
        ended_at: new Date().toISOString(),
      });
      throw new Error(`Approval for "${options.name}" expired without a decision`);
    }

    // Still pending — pause again
    throw new PauseSignal(existingApproval.id);
  }

  // First time hitting this step — create the run_step and approval row
  const runStep = await db.createRunStep({
    run_id: ctx.runId,
    step_index: idx,
    step_name: options.name,
    step_type: "await_approval",
    status: "running",
    input: { prompt: options.prompt, from: options.from },
  });

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

  throw new PauseSignal(approvalId);
}

// ─── Internal helper ──────────────────────────────────────────────────────────

interface ExistingApproval {
  id: string;
  runStepId: string;
  status: string;
  decision_notes: string | null;
  decided_by: string | null;
}

async function findPendingApproval(
  ctx: RunContext,
  stepIndex: number,
): Promise<ExistingApproval | null> {
  // Look for a run_step at this index (any status)
  const rows = await fetch(
    `${ctx.env.SUPABASE_URL}/rest/v1/orchestration.run_steps?run_id=eq.${ctx.runId}&step_index=eq.${stepIndex}&step_type=eq.await_approval&select=id&limit=1`,
    {
      headers: {
        apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  ).then((r) => r.json() as Promise<{ id: string }[]>);

  const runStepId = rows[0]?.id;
  if (!runStepId) return null;

  const approvalRows = await fetch(
    `${ctx.env.SUPABASE_URL}/rest/v1/orchestration.approvals?run_step_id=eq.${runStepId}&select=id,status,decision_notes,decided_by&limit=1`,
    {
      headers: {
        apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  ).then(
    (r) =>
      r.json() as Promise<
        { id: string; status: string; decision_notes: string | null; decided_by: string | null }[]
      >,
  );

  const approval = approvalRows[0];
  if (!approval) return null;

  return {
    id: approval.id,
    runStepId,
    status: approval.status,
    decision_notes: approval.decision_notes,
    decided_by: approval.decided_by,
  };
}
