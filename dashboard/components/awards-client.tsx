"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Trophy, Trash2, Loader2, ExternalLink } from "lucide-react";
import type { Award } from "@/app/(dashboard)/records/bd/awards";
import { ScoreCell } from "@/components/records-score";

interface Props {
  awards: Award[];
  dismissAward: (formData: FormData) => Promise<void>;
}

type RecFilter = "all" | "apply" | "consider" | "skip";
type TypeFilter = "all" | "industry" | "government";
/**
 * Primary axis, promoted into the page header as a segmented control to match the
 * Opportunities tab. `cycle_status` is the right axis here: it is populated on every
 * row, and it answers the only question that gates action -- can we still apply?
 * The deadline columns are text and null on more than half the rows, so they cannot
 * carry a filter the way `response_deadline` does on Opportunities.
 */
type CycleFilter = "open" | "closed" | "all";

// The redesign flattens the old semantically-coloured badges onto the three
// Nocturne `.tag` variants (accent = a live/positive signal, neutral = default,
// outline = de-emphasised), so nothing introduces a colour literal outside the
// token sheet. Scores are the one place colour still carries meaning, via ScoreCell.
type TagVariant = "tag-accent" | "tag-neutral" | "tag-outline";

const REC_TAG: Record<string, TagVariant> = {
  apply: "tag-accent",
  consider: "tag-neutral",
  skip: "tag-outline",
};

function Tag({ text, variant }: { text: string; variant: TagVariant }) {
  return <span className={`tag ${variant}`} style={{ textTransform: "capitalize" }}>{text}</span>;
}

export function AwardsClient({ awards, dismissAward }: Props) {
  const [rec, setRec] = useState<RecFilter>("all");
  const [type, setType] = useState<TypeFilter>("all");
  // Replaces the old "Open only" toggle, which was the same axis expressed as a
  // two-state button. One control, three explicit states, and the counts are visible
  // without changing the filter to discover them.
  const [cycle, setCycle] = useState<CycleFilter>("open");

  const filtered = awards.filter(
    (a) =>
      (rec === "all" || a.recommendation === rec) &&
      (type === "all" || a.award_type === type) &&
      (cycle === "all" || a.cycle_status === cycle),
  );
  const applyCount = awards.filter((a) => a.recommendation === "apply").length;
  const openCount = awards.filter((a) => a.cycle_status === "open").length;
  const closedCount = awards.filter((a) => a.cycle_status === "closed").length;
  const CYCLES: Array<{ key: CycleFilter; label: string; count: number }> = [
    { key: "open", label: "Open", count: openCount },
    { key: "closed", label: "Closed", count: closedCount },
    { key: "all", label: "All", count: awards.length },
  ];

  return (
    <div className="page view-fade" style={{ paddingTop: 0 }}>
      <div className="page-h">
        <div>
          <h1>Awards</h1>
          <div className="sub">
            {awards.length === 0
              ? "No awards on the radar yet."
              : `${cycle === "all" ? awards.length : cycle === "open" ? openCount : closedCount} ${cycle === "all" ? "tracked" : cycle} of ${awards.length} tracked · ${applyCount} recommended to apply`}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {awards.length > 0 && (
            <div className="records-seg" role="group" aria-label="Filter by application cycle">
              {CYCLES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={cycle === c.key}
                  className={`records-seg-opt${cycle === c.key ? " active" : ""}`}
                  onClick={() => setCycle(c.key)}
                >
                  {c.label} <span style={{ opacity: 0.6 }}>{c.count}</span>
                </button>
              ))}
            </div>
          )}
          {/* The award sweep is Cleo's; run it from her chat (matches the empty-state hint). */}
          <Link href="/agents/cleo" className="btn">Run a sweep</Link>
        </div>
      </div>

      <p className="sub" style={{ marginBottom: 16, maxWidth: 760 }}>
        Cleo&apos;s weekly sweep for industry recognition and government small-business award programs,
        scored on <strong>fit</strong>, <strong>prestige</strong>, and application <strong>effort</strong>.
        Focus on the <strong>apply</strong>-rated ones with near deadlines; dismiss anything off-target.
      </p>

      {awards.length > 0 && (
        <div className="rec-filters">
          <div className="rec-filter-group">
            {(["all", "apply", "consider", "skip"] as RecFilter[]).map((r) => (
              <button key={r} className={`rec-filter${rec === r ? " active" : ""}`} onClick={() => setRec(r)}>{r}</button>
            ))}
          </div>
          <div className="rec-filter-group">
            {(["all", "industry", "government"] as TypeFilter[]).map((t) => (
              <button key={t} className={`rec-filter${type === t ? " active" : ""}`} onClick={() => setType(t)}>{t}</button>
            ))}
          </div>
        </div>
      )}

      {awards.length === 0 ? (
        <div className="empty">
          <div className="ico"><Trophy /></div>
          <h4>No awards yet.</h4>
          <p>Cleo&apos;s weekly award sweep hasn&apos;t surfaced anything yet, or run a sweep from the Cleo chat.</p>
        </div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ width: "34%" }}>Award</th>
                <th>Type</th>
                <th>Cycle</th>
                <th>Deadline</th>
                <th style={{ textAlign: "right" }}>Fit</th>
                <th>Prestige</th>
                <th>Effort</th>
                <th>Rec.</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ textAlign: "center", padding: 40, color: "var(--ink-2)" }}>
                    No awards match these filters.
                  </td>
                </tr>
              )}
              {filtered.map((a) => (
                <AwardRow key={a.id} award={a} dismissAward={dismissAward} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AwardRow({ award: a, dismissAward }: { award: Award; dismissAward: Props["dismissAward"] }) {
  const [pending, start] = useTransition();
  const deadline = a.application_deadline ?? a.nomination_deadline;

  return (
    <tr className="rec-row">
      <td>
        <div style={{ fontWeight: 500, color: "var(--ink)" }}>
          {a.source_url ? (
            <a href={a.source_url} target="_blank" rel="noreferrer" style={{ color: "var(--ink)", textDecoration: "none" }}>
              {a.title} <ExternalLink style={{ width: 11, height: 11, verticalAlign: "middle", color: "var(--ink-3)" }} />
            </a>
          ) : a.title}
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
          {[a.sponsor, a.category].filter(Boolean).join(" · ") || "-"}
        </div>
      </td>
      <td><Tag text={a.award_type === "government" ? "Gov" : "Industry"} variant="tag-neutral" /></td>
      <td>{a.cycle_status ? <Tag text={a.cycle_status} variant={a.cycle_status === "open" ? "tag-accent" : "tag-neutral"} /> : "-"}</td>
      <td className="mono" style={{ fontSize: 12, color: "var(--ink-2)", whiteSpace: "nowrap" }}>{deadline ?? "-"}</td>
      <td style={{ textAlign: "right" }}><ScoreCell score={a.fit_score} max={10} /></td>
      <td>{a.prestige ? <Tag text={a.prestige} variant={a.prestige === "high" ? "tag-accent" : "tag-neutral"} /> : "-"}</td>
      <td>{a.effort ? <Tag text={a.effort} variant={a.effort === "high" ? "tag-outline" : "tag-neutral"} /> : "-"}</td>
      <td><Tag text={a.recommendation} variant={REC_TAG[a.recommendation] ?? "tag-outline"} /></td>
      <td style={{ textAlign: "right" }}>
        <form action={(fd) => start(async () => { await dismissAward(fd); })} style={{ display: "inline" }}>
          <input type="hidden" name="id" value={a.id} />
          <button type="submit" className="btn ghost sm" disabled={pending} title="Dismiss (remove from the radar)">
            {pending ? <Loader2 className="spin" style={{ width: 13, height: 13 }} /> : <Trash2 style={{ width: 13, height: 13 }} />}
          </button>
        </form>
      </td>
    </tr>
  );
}
