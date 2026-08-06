"use client";

import { useOptimistic } from "react";
import { AgentMark } from "@/components/agent-mark";
import { agentOfOrchestration, bareOrchestration } from "@/lib/agent-style";
import { fmtTimeAgo, fmtAbs, fmtExpiry } from "@/components/lumi";

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
}

function byExpiry(a: ApprovalItem, b: ApprovalItem): number {
  const ta = a.expires_at ? new Date(a.expires_at).getTime() : Infinity;
  const tb = b.expires_at ? new Date(b.expires_at).getTime() : Infinity;
  return ta - tb;
}

// Urgent = under two hours left; the expiry tag flips to accent to match the spec.
function isUrgent(iso: string | null): boolean {
  if (!iso) return false;
  const ms = new Date(iso).getTime() - Date.now();
  return ms >= 0 && ms < 2 * 60 * 60 * 1000;
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
        orch: bareOrchestration(src.orchestrationName) || "—",
        approved: d.approved,
        by: d.by,
        at: d.at,
      } satisfies DecidedRow;
    })
    .filter((r): r is DecidedRow => r !== null);

  // Decided items collapse in place, but we only surface a recent slice inline
  // so the screen stays about what still needs a decision — not an ever-growing
  // audit log. `decided` arrives newest-first from the query's created_at order.
  const serverRows: DecidedRow[] = decided.slice(0, 20).map((a) => ({
    id: a.id,
    orch: bareOrchestration(a.orchestrationName) || "—",
    approved: a.status === "approved",
    by: a.decided_by ?? "—",
    at: a.decided_at ?? a.created_at,
  }));

  const decidedRows = [...optRows, ...serverRows];

  const pendingCount = livePending.length;
  const oldest = oldestExpiryLabel(livePending);
  const sub =
    pendingCount === 0
      ? "Nothing waiting on you — all caught up"
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
            value={rate == null ? "—" : String(rate)}
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
  const orch = bareOrchestration(approval.orchestrationName) || "—";
  const agentName = slug ? slug[0].toUpperCase() + slug.slice(1) : "System";
  const expiry = fmtExpiry(approval.expires_at);
  const urgent = isUrgent(approval.expires_at);

  return (
    <div className="apv-card">
      <div className="apv-head">
        <AgentMark slug={slug ?? "system"} name={slug ?? orch} size={30} />
        <div className="apv-id">
          <span className="apv-orch mono">{orch}</span>
          <span className="apv-sub">
            {agentName} · requested {fmtTimeAgo(approval.created_at)}
          </span>
        </div>
        {expiry && (
          <span className={`tag ${urgent ? "tag-accent" : "tag-neutral"}`}>{expiry}</span>
        )}
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
        <input type="text" name="notes" className="apv-note" placeholder="Add a note…" />
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

function DecidedRowView({ row }: { row: DecidedRow }) {
  return (
    <div className="apv-decided">
      <span
        className="apv-dot"
        style={{ background: row.approved ? "var(--ok)" : "var(--err)" }}
        aria-hidden="true"
      />
      <span className="apv-decided-orch mono">{row.orch}</span>
      <span className="apv-decided-text">
        {row.approved ? "approved" : "declined"} by {row.by} · {fmtAbs(row.at)}
      </span>
    </div>
  );
}
