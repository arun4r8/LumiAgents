"use client";

import Link from "next/link";

import type { BdAnalytics, Bucket } from "@/lib/bd-analytics";

export interface DeliveryAnalytics {
  openIssues: number;
  byStatus: { label: string; count: number }[];
  byArea: { label: string; count: number }[];
  staleOver30d: number;
  closedThisWeek: number;
  oldestOpenDays: number | null;
  generatedAt: string;
}

function Stat({ value, label, unit, href }: { value: string | number; label: string; unit?: string; href?: string }) {
  const inner = (
    <div>
      <div className="ov-stat-v">
        {value}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      <div className="an-stat-l">{label}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="ov-stat-link">
      {inner}
    </Link>
  ) : (
    inner
  );
}

/** Horizontal bars. Widths are relative to the largest row, so the shape reads at a glance. */
function BarList({ rows, max, empty }: { rows: Bucket[]; max: number; empty: string }) {
  if (rows.length === 0) return <p className="an-empty">{empty}</p>;
  const top = rows[0]?.total ?? 1;
  return (
    <div className="an-bars">
      {rows.slice(0, max).map((r) => (
        <div className="an-bar-row" key={r.label}>
          <div className="an-bar-label" title={r.label}>
            {r.label}
          </div>
          <div className="an-bar-track">
            <i style={{ width: `${Math.max(2, (r.total / top) * 100)}%` }} />
            {/* The strong-fit share is drawn inside the same bar rather than beside
                it: "how many, and how many are good" is one question. */}
            <i className="an-bar-strong" style={{ width: `${Math.max(0, (r.strong / top) * 100)}%` }} />
          </div>
          <div className="an-bar-n">{r.total}</div>
          <div className="an-bar-sub">
            {r.strong > 0 ? `${r.strong} at 7+` : "-"}
            {r.live > 0 ? ` · ${r.live} live` : ""}
            {r.avgFit !== null ? ` · avg ${r.avgFit}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AnalyticsClient({ bd, delivery }: { bd: BdAnalytics; delivery: DeliveryAnalytics | null }) {
  const maxBar = Math.max(1, ...bd.distribution.map((d) => d.count));
  const titleOnly = bd.total - bd.bodyScored;

  return (
    <div className="page">
      <h1 className="an-h1">Analytics</h1>

      {/* ── Delivery ─────────────────────────────────────────────────────────── */}
      <h2 className="ov-sec">Delivery</h2>
      {delivery === null ? (
        <p className="an-empty">
          Delivery figures are unavailable: GitHub did not answer. The BD half below is unaffected.
        </p>
      ) : (
        <>
          <div className="ov-stats">
            <Stat value={delivery.openIssues} label="open issues" />
            <Stat value={delivery.closedThisWeek} label="closed this week" />
            <Stat value={delivery.staleOver30d} label="untouched 30d+" />
            {delivery.oldestOpenDays !== null ? (
              <Stat value={delivery.oldestOpenDays} unit="d" label="oldest open" />
            ) : null}
          </div>

          <div className="an-cols">
            <section>
              <h3 className="an-sub">By status</h3>
              <BarList
                rows={delivery.byStatus.map((s) => ({ label: s.label, total: s.count, strong: 0, live: 0, avgFit: null }))}
                max={8}
                empty="No status labels."
              />
            </section>
            <section>
              <h3 className="an-sub">By area</h3>
              <BarList
                rows={delivery.byArea.map((s) => ({ label: s.label, total: s.count, strong: 0, live: 0, avgFit: null }))}
                max={8}
                empty="No area labels."
              />
            </section>
          </div>
        </>
      )}

      {/* ── BD pipeline ──────────────────────────────────────────────────────── */}
      <h2 className="ov-sec is-second">BD pipeline</h2>

      <div className="ov-stats">
        <Stat value={bd.total} label="opportunities" href="/records/bd?tab=opportunities" />
        <Stat value={bd.liveCount} label="deadline still open" />
        <Stat value={bd.strongLive} label="live and 7+" />
        {bd.avgFit !== null ? <Stat value={bd.avgFit} label="mean fit" /> : null}
        <Stat value={bd.pursued} label="pursued" href="/records/bd?tab=board" />
        <Stat value={bd.total - bd.triaged} label="awaiting triage" />
      </div>

      {/* The caveat, given the weight it deserves. A fit score computed from a title
          is not the same kind of number as one computed from the notice, and nothing
          on an opportunity card distinguishes them. */}
      {titleOnly > 0 ? (
        <p className="an-caveat">
          <strong>{titleOnly} of {bd.total}</strong> opportunities are still scored on their title alone.
          SAM returns a link where the notice text should be, so every score predates the body being
          fetched at all; the hydrator is working through the backlog and these scores will move.
          Treat them as provisional.
        </p>
      ) : null}

      <div className="an-cols">
        <section>
          <h3 className="an-sub">Fit distribution</h3>
          <div className="an-dist">
            {bd.distribution.map((d) => (
              <div className="an-dist-col" key={d.score}>
                <div className="an-dist-bar">
                  <i style={{ height: `${Math.max(2, (d.count / maxBar) * 100)}%` }} className={d.score >= 7 ? "is-strong" : ""} />
                </div>
                <div className="an-dist-n">{d.count}</div>
                <div className="an-dist-s">{d.score}</div>
              </div>
            ))}
          </div>
          <p className="an-note">
            Scores below 5 are recorded but not stored as opportunities. Seeing them at all is new -
            the model used to return only the shortlist.
          </p>
        </section>

        <section>
          <h3 className="an-sub">By NAICS</h3>
          <BarList rows={bd.byNaics} max={8} empty="No NAICS recorded." />
          <p className="an-note">
            The sweep&rsquo;s one real tuning knob. A code carrying volume without 7s is a candidate
            for removal, which is how 541330 came out.
          </p>
        </section>
      </div>

      <h3 className="an-sub is-wide">By agency</h3>
      <BarList rows={bd.byAgency} max={14} empty="No agencies recorded." />
    </div>
  );
}
