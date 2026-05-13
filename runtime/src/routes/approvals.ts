import type { Env } from "../types";
import { SupabaseClient } from "../db/client";
import { json, requireOpsToken } from "./helpers";

export async function handleApprovals(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/respond$/);
  if (!approvalMatch || request.method !== "POST") return null;

  const approvalId = approvalMatch[1];
  if (!approvalId) return json({ error: "Missing approval ID" }, 400);

  const authResult = requireOpsToken(request);
  if (authResult instanceof Response) return authResult;
  const { userId: decidedByUserId } = authResult;

  let body: { approved: boolean; notes?: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.approved !== "boolean") {
    return json({ error: "'approved' (boolean) is required" }, 422);
  }

  const db = new SupabaseClient(env);

  await db.respondToApproval(approvalId, {
    approved: body.approved,
    decidedBy: decidedByUserId,
    ...(body.notes !== undefined && { notes: body.notes }),
  });

  const approval = await db.getApproval(approvalId);
  return json({ runId: approval.run_id, status: body.approved ? "approved" : "rejected" });
}
