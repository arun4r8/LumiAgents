import { NextResponse } from "next/server";
import { loadRunSnapshot } from "@/lib/run-snapshot";
import type { RunSnapshotResponse } from "@/lib/run-view";

export const dynamic = "force-dynamic";

/**
 * GET /api/runs/:id — the live snapshot behind the embedded run card and the
 * run-detail timeline.
 *
 * The whole read runs through the caller's own Supabase session (see
 * lib/run-snapshot.ts), so RLS decides visibility: ops see every run, an enduser
 * sees the runs their chat started (`triggered_by_user_id = auth.uid()`) plus any
 * run they are the approver on. There is no service-role path here by design — a
 * run the caller may not read comes back `{ visible: false }`, which the card
 * renders as a quiet "not available" line rather than an error.
 *
 * Responses are explicitly uncacheable: this is polled while a run is in flight.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const snapshot = await loadRunSnapshot(id);

  const body: RunSnapshotResponse = snapshot
    ? { visible: true, snapshot }
    : { visible: false };

  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
