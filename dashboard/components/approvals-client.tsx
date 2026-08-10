"use client";

import { useOptimistic, useState } from "react";
import Link from "next/link";
import { AgentMark } from "@/components/agent-mark";
import { agentOfOrchestration, bareOrchestration } from "@/lib/agent-style";
import { LocalTime, UrgencyTag, fmtExpiry, useMounted } from "@/components/lumi";

/**
 * Approvals — the redesign's single most important functional surface.
 *
 * Each pending request renders as a card (30px agent mark + mono orchestration
 * name + sub, right-aligned expiry `.tag`, accent-bordered prompt, primary
 * Approve / ghost Decline / note input). On a decision the card collapses to a
 * one-line decided row (status dot + mono name + "approved by … · time").
 *
 * The decision itself still travels through the server action passed in as
 * `decide` (POST to the runtime, then revalidate) — that path is unchanged.
 * `useOptimistic` only drives the *visual* collapse while the action is in
 * flight; when the action resolves and the server re-renders with fresh
 * pending/decided lists, the optimistic state is discarded and the real row
 * takes over. If the action throws, the optimistic decision reverts and the
 * card comes back, so nothing is lost.
 */

export interface ApprovalItem {
  id: string;
  prompt: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  /** Full orchestration name, e.g. "beady/rfi-draft". */
  orchestrationName: string | null;
  /** The run this approval gates, for the "View run →" link. Null = no run (rare). */
  runId: string | null;
}

/** Rolling-window counts computed server-side from the single approvals fetch. */
export interface ApprovalStats {
  total30: number;
  decided30: number;
  approved30: number;
}

interface Props {
  pending: ApprovalItem[];
  decided: ApprovalItem[];
  /** Current user's label, used for the optimistic "approved by …" line. */
  me: string;
  stats: ApprovalStats;
  /** ISO cutoff for the stat window; a pending item older than this is outside it. */
  cutoffIso: string;
  windowDays: number;
  decide: (formData: FormData) => Promise<void>;
}

type Decision = { id: string; approved: boolean; by: string; at: string };

interface DecidedRow {
  id: string;
  orch: string;
  approved: boolean;
  by: string;
  at: string;
  /** What was decided. Truncated in the row; the full text stays in the title. */
  prompt: string;
  /** The run this approval gated, so history keeps its way back to the evidence. */
  runId: string | null;
}

function byExpiry(a: ApprovalItem, b: ApprovalItem): number {
  const ta = a.expires_at ? new Date(a.expires_at).getTime() : Infinity;
  const tb = b.expires_at ? new Date(b.expires_at).getTime() : Infinity;
  return ta - tb;
}

function oldestExpiryLabel(items: ApprovalItem[]): string | null {
  const withExp = items.filter((i) => i.expires_at).sort(byExpiry);
  return withExp.length ? fmtExpiry(withExp[0].expires_at) : null;
}

export function ApprovalsClient({
  pending,
  decided,
  me,
  stats,
  cutoffIso,
  windowDays,
  decide,
}: Props) {
  const [optimistic, addDecision] = useOptimistic<Decision[], Decision>(
    [],
    (state, d) => [...state.filter((x) => x.id !== d.id), d],
  );
  // The inline decided list is capped so the page stays about what still needs a
  // decision; the cap is labelled and has a toggle so a truncated list can never
  // masquerade as the whole history. All decided rows are already in hand (the
  // page fetched them), so "Show all" is a pure client expand, no new round trip.
  const [showAllDecided, setShowAllDecided] = useState(false);

  const optIds = new Set(optimistic.map((d) => d.id));
  const livePending = pending.filter((p) => !optIds.has(p.id)).slice().sort(byExpiry);

  // Cards just decided this session collapse in place, newest first, above the
  // rows the server already knows are decided.
  const optRows: DecidedRow[] = optimistic
    .map((d) => {
      const src = pending.find((p) => p.id === d.id);
      if (!src) return null;
      return {
        id: d.id,
        orch: bareOrchestration(src.orchestrationName) || "-",
        approved: d.approved,
        by: d.by,
        at: d.at,
        prompt: src.prompt,
        runId: src.runId,
      } satisfies DecidedRow;
    })
    .filter((r): r is DecidedRow => r !== null);

  // Decided items collapse in place, but we only surface a recent slice inline
  // so the screen stays about what still needs a decision — not an ever-growing
  // audit log. `decided` arrives newest-first from the query's created_at order.
  const DECIDED_CAP = 20;
  const decidedTotal = decided.length;
  const shownServer = showAllDecided ? decided : decided.slice(0, DECIDED_CAP);
  const serverRows: DecidedRow[] = shownServer.map((a) => ({
    id: a.id,
    orch: bareOrchestration(a.orchestrationName) || "-",
    approved: a.status === "approved",
    by: a.decided_by ?? "-",
    at: a.decided_at ?? a.created_at,
    prompt: a.prompt,
    runId: a.runId,
  }));

  const decidedRows = [...optRows, ...serverRows];
  const decidedCapped = decidedTotal > DECIDED_CAP;

  const pendingCount = livePending.length;
  // oldestExpiryLabel runs through fmtExpiry, i.e. Date.now() — gated so the
  // server and the hydrating client agree. Pre-mount the subtitle simply omits
  // the clause rather than asserting a stale interval.
  const mounted = useMounted();
  const oldest = mounted ? oldestExpiryLabel(livePending) : null;
  const sub =
    pendingCount === 0
      ? "Nothing waiting on you, all caught up"
      : `${pendingCount} waiting on you${oldest ? ` · oldest ${oldest.toLowerCase()}` : ""}`;

  // 30-day stats, recomputed with this session's optimistic decisions folded in.
  // Deciding a pending item created inside the window bumps decided (and approved,
  // if it was approved); total is unchanged — the item was already counted in it.
  const cutoffMs = Date.parse(cutoffIso);
  let decided30 = stats.decided30;
  let approved30 = stats.approved30;
  for (const d of optimistic) {
    const src = pending.find((p) => p.id === d.id);
    if (src && Date.parse(src.created_at) >= cutoffMs) {
      decided30 += 1;
      if (d.approved) approved30 += 1;
    }
  }
  // approved ÷ decided, never ÷ total. Zero decided → null → an em-dash, never
  // "0%" (which would read as "everything was declined").
  const rate = decided30 === 0 ? null : Math.round((approved30 / decided30) * 100);
  const showStats = stats.total30 > 0 || livePending.length > 0;

  async function runDecision(formData: FormData) {
    const id = formData.get("approvalId") as string;
    const approved = formData.get("status") === "approved";
    addDecision({ id, approved, by: me, at: new Date().toISOString() });
    await decide(formData);
  }

  return (
    <div className="page view-fade" style={{ maxWidth: 860 }}>
      <div className="page-h">
        <div>
          <h1>Approvals</h1>
          <div className="sub">{sub}</div>
        </div>
      </div>

      {showStats && (
        <div className="ov-stats apv-stats">
          <Stat
            value={rate == null ? "-" : String(rate)}
            unit={rate == null ? undefined : "%"}
            label={`approval rate · last ${windowDays} days`}
            accent
          />
          <Stat value={String(decided30)} label={`decided · last ${windowDays} days`} />
          <Stat value={String(stats.total30)} label={`requests · last ${windowDays} days`} />
        </div>
      )}

      <div className="apv-list">
        {livePending.map((a) => (
          <PendingCard key={a.id} approval={a} runDecision={runDecision} />
        ))}
        {decidedRows.map((r) => (
          <DecidedRowView key={r.id} row={r} />
        ))}
        {decidedCapped && (
          <div className="apv-decided-more">
            <span>
              Showing {showAllDecided ? decidedTotal : DECIDED_CAP} of {decidedTotal} decided
            </span>
            <button
              type="button"
              className="apv-linkbtn"
              onClick={() => setShowAllDecided((v) => !v)}
            >
              {showAllDecided ? "Show fewer" : "Show all"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PendingCard({
  approval,
  runDecision,
}: {
  approval: ApprovalItem;
  runDecision: (formData: FormData) => Promise<void>;
}) {
  const slug = agentOfOrchestration(approval.orchestrationName);
  const orch = bareOrchestration(approval.orchestrationName) || "-";
  const agentName = slug ? slug[0].toUpperCase() + slug.slice(1) : "System";

  return (
    <div className="apv-card">
      <div className="apv-head">
        <AgentMark slug={slug ?? "system"} name={slug ?? orch} size={30} />
        <div className="apv-id">
          <span className="apv-orch mono">{orch}</span>
          <span className="apv-sub">
            {agentName} · requested <LocalTime iso={approval.created_at} format="ago" placeholder="-" />
          </span>
        </div>
        <UrgencyTag expiresAt={approval.expires_at} />
      </div>

      <div className="apv-prompt">{approval.prompt}</div>

      <form action={runDecision} className="apv-actions">
        <input type="hidden" name="approvalId" value={approval.id} />
        <button type="submit" name="status" value="approved" className="btn primary">
          Approve
        </button>
        <button type="submit" name="status" value="rejected" className="btn ghost">
          Decline
        </button>
        {/* A decision rationale is prose, not a search box: a single-line input
            silently caps what a reviewer can say. Compact by default (2 rows,
            the length of most notes) and resizable for the ones that are not. */}
        <textarea name="notes" className="apv-note" rows={2} placeholder="Add a note…" />
        {/* The only path from "approve this" to "see what I'm approving". Kept in
            the actions row, right of the note, so it sits with the decision. */}
        {approval.runId && (
          <Link href={`/runs/${approval.runId}`} className="apv-runlink">
            View run →
          </Link>
        )}
      </form>
    </div>
  );
}

// Same stat treatment as the redesigned Overview (`.ov-stat-*`), so the band
// reads as native to the system rather than imported from the old SLA board.
function Stat({
  value,
  unit,
  label,
  accent,
}: {
  value: string;
  unit?: string;
  label: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className={accent ? "ov-stat-v is-accent" : "ov-stat-v"}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      <div className="ov-stat-l">{label}</div>
    </div>
  );
}

// A collapsed row still has to answer "what was decided, and where did it come
// from". A status dot plus an orchestration name answers neither. The prompt
// preview (single line, ellipsised, full text on hover) and the "View run" link
// are what make the history readable rather than merely present.
function DecidedRowView({ row }: { row: DecidedRow }) {
  const preview = row.prompt.trim();

  return (
    <div className="apv-decided">
      <span
        className="apv-dot"
        style={{ background: row.approved ? "var(--ok)" : "var(--err)" }}
        aria-hidden="true"
      />
      <span className="apv-decided-orch mono">{row.orch}</span>
      <span className="apv-decided-prompt truncate" title={preview || undefined}>
        {preview || "-"}
      </span>
      <span className="apv-decided-text">
        {row.approved ? "approved" : "declined"} by {row.by} · <LocalTime iso={row.at} />
      </span>
      {row.runId && (
        <Link href={`/runs/${row.runId}`} className="apv-runlink">
          View run →
        </Link>
      )}
    </div>
  );
}
