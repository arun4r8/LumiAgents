"use client";

import Link from "next/link";
import { sourceLabel } from "@/lib/opportunity-source";
import type { BidGateResult } from "@/lib/bid-gates";
import { useFormStatus } from "react-dom";
import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Radar } from "lucide-react";
import { ScoreCell } from "@/components/records-score";
import { LocalTime } from "@/components/lumi";

/**
 * Opportunities — the GovCon BD pipeline over `public.opportunities`. Beady
 * sweeps SAM.gov, scores each notice and writes fit_score / recommendation /
 * red_flags, so this is a go/no-go pipeline, not a raw table browser. It used
 * to be filed under /records/data's "govcon" tab; it now lives on the BD
 * Pipeline screen where it belongs.
 */

export interface Opportunity {
  id: string;
  title: string | null;
  agency: string | null;
  set_aside: string | null;
  fit_score: number | null;
  fit_reason: string | null;
  red_flags: string | null;
  recommendation: string | null;
  response_deadline: string | null;
  solicitation_number: string | null;
  source_url: string | null;
  disposition: "pursue" | "watch" | "ignore" | null;
  sharepoint_folder_url: string | null;
  naics_code: string | null;
  last_scored_at: string | null;
  /** When the sweep first stored this opportunity. Distinct from last_scored_at,
   *  which moves every time it is re-scored (125 of 292 rows differ). */
  created_at: string | null;
  source: string | null;
  /** GovWin only: the export it was imported from. */
  source_file: string | null;
  /** Tommy's bid/no-bid gates, evaluated on the server (#197). */
  bid_gate?: BidGateResult;
}

// Beady's recommendation vocabulary is pursue | monitor | pass (see the column
// comment in migration 20260506000006). Mapped onto the three Nocturne .tag
// variants so no new colour literal is introduced.
/**
 * Submit button that disables itself only WHILE its own form is submitting.
 *
 * The first version called `startTransition` in onClick and read `disabled` from that
 * transition's pending flag. React re-rendered with disabled=true before the browser
 * processed the click's default action, and a disabled button does not submit its
 * form -- so every click silently cancelled itself and none of the buttons worked.
 *
 * `useFormStatus` reports the enclosing form's status instead, which is false at click
 * time and true only once submission is under way. It must live in a CHILD of the
 * form; called in the same component that renders <form>, it always returns false.
 */
function DispositionButton({
  value,
  active,
  label,
}: {
  value: string;
  active: boolean;
  label: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-pressed={active}
      title={active ? `Clear "${value}"` : label}
      className={`rec-filter${active ? " active" : ""}`}
      style={{
        textTransform: "capitalize",
        fontSize: 11,
        padding: "2px 7px",
        width: "100%",
        opacity: pending ? 0.5 : 1,
      }}
    >
      {value}
    </button>
  );
}

const DISPOSITION_HINT: Record<"pursue" | "watch" | "ignore", string> = {
  pursue: "Pursue: enters the proposal workflow",
  watch: "Watch: stays on the list, no workflow",
  ignore: "Ignore: hidden from this list (reversible)",
};

const REC_TAG: Record<string, "tag-accent" | "tag-neutral" | "tag-outline"> = {
  pursue: "tag-accent",
  monitor: "tag-neutral",
  pass: "tag-outline",
};

interface Props {
  opportunities: Opportunity[];
  /** True row count of public.opportunities, counted server-side. */
  total: number;
  /** True count of scored rows (fit_score not null), counted server-side. */
  scoredTotal: number;
  /** The server's page cap. Hitting it means rows were left behind. */
  limit: number;
  /** Which deadline bucket is being shown (#174 follow-up; see ./records/bd/opportunities.tsx). */
  deadline: "open" | "past" | "all";
  /** Rows whose deadline has not passed (or is unknown), counted server-side. */
  openCount: number;
  /** Rows whose deadline has passed, counted server-side. */
  pastCount: number;
  /** Rows a human has ignored -- counted WITHOUT the ignore filter, since this is
   *  what the "show ignored" affordance reports. */
  ignoredCount: number;
  showIgnored: boolean;
  setDisposition: (formData: FormData) => Promise<void>;
}

export function OpportunitiesClient({ opportunities, total, scoredTotal, limit, deadline, openCount, pastCount, ignoredCount, showIgnored, setDisposition }: Props) {
  // The page is capped and ordered by fit, so unscored rows sort last and are
  // the first thing to fall off the end. Saying "200 tracked" when there are
  // 512 would make a freshly swept, not-yet-scored notice invisible AND make
  // the screen look complete, so the header states the cap outright.
  // `total` is every row in the table, not the filtered bucket, so the header can say
  // what is being hidden. A filtered view that only reports its own size is how a
  // default filter gets mistaken for missing data.
  const shown = deadline === "open" ? openCount : deadline === "past" ? pastCount : total;
  const truncated = opportunities.length >= limit && shown > opportunities.length;
  const scope =
    deadline === "open" ? "still open" : deadline === "past" ? "past deadline" : "all";
  const sub = truncated
    ? `Showing the top ${opportunities.length} by fit of ${shown} ${scope} · ${total} tracked · ${scoredTotal} scored`
    : `${shown} ${scope} of ${total} tracked · ${scoredTotal} scored`;

  const FILTERS = [
    { key: "open", label: "Open", count: openCount },
    { key: "past", label: "Past deadline", count: pastCount },
    { key: "all", label: "All", count: total },
  ] as const;

  return (
    <div className="page view-fade" style={{ paddingTop: 0 }}>
      <div className="page-h">
        <div>
          <h1>Opportunities</h1>
          <div className="sub">
            {opportunities.length === 0
              ? deadline === "open"
                ? "Nothing open right now. Try Past deadline or All."
                : "No opportunities on the radar yet."
              : sub}
          </div>
          {truncated && (
            <div className="sub" style={{ marginTop: 3 }}>
              Ordered by fit score, so unscored notices sort last and may not appear here yet.
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Links, not buttons: the filter lives in the URL so a view is shareable,
              and it matches the tab control directly above. */}
          <div className="records-seg" role="group" aria-label="Filter by response deadline">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={`/records/bd?tab=opportunities&deadline=${f.key}`}
                aria-current={deadline === f.key ? "true" : undefined}
                className={`records-seg-opt${deadline === f.key ? " active" : ""}`}
              >
                {f.label} <span style={{ opacity: 0.6 }}>{f.count}</span>
              </Link>
            ))}
          </div>
          {ignoredCount > 0 && (
            // Ignoring is a soft hide, so there has to be a way back to what was
            // hidden -- otherwise a mis-click is indistinguishable from a deletion.
            <Link
              href={`/records/bd?tab=opportunities&deadline=${deadline}${showIgnored ? "" : "&ignored=1"}`}
              className={`rec-filter${showIgnored ? " active" : ""}`}
              style={{ fontSize: 12 }}
            >
              {showIgnored ? "Hide ignored" : `Show ignored (${ignoredCount})`}
            </Link>
          )}
          {/* opportunity-sweep is Beady's; run it from her chat. */}
          <Link href="/agents/beady" className="btn">Run a sweep</Link>
        </div>
      </div>

      {opportunities.length === 0 ? (
        <div className="empty">
          <div className="ico"><Radar /></div>
          <h4>No opportunities yet.</h4>
          <p>Run <code className="mono">beady/opportunity-sweep</code> from Beady&apos;s chat to sweep SAM.gov and score what comes back.</p>
        </div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ width: "36%" }}>Opportunity</th>
                <th>Agency</th>
                <th>Set-aside</th>
                <th style={{ textAlign: "right" }}>Fit</th>
                <th>Rec.</th>
                <th>Deadline</th>
                <th>Swept</th>
                <th>Source</th>
                {/* There used to be a "Status" header with no cell beneath it: nine
                    headers over eight columns, so every label from Status rightward
                    sat above the wrong column and the detail row spanned 8. */}
                <th>Decision</th>
                <th aria-label="Expand" />
              </tr>
            </thead>
            <tbody>
              {opportunities.map((o) => (
                <OpportunityRow key={o.id} opp={o} setDisposition={setDisposition} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OpportunityRow({
  opp: o,
  setDisposition,
}: {
  opp: Opportunity;
  setDisposition: (formData: FormData) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const rec = o.recommendation?.toLowerCase() ?? null;
  const hasDetail = !!(o.fit_reason || o.red_flags || o.solicitation_number || o.last_scored_at || o.bid_gate);

  return (
    <>
      {/* Tommy: "make opportunity text highlightable for copy/paste". Nothing was
          setting user-select: none -- the row itself toggles on click, so a
          drag-to-select ended as a toggle and the selection was lost. Bail out when
          the user has actually selected something, which keeps the click affordance
          and makes the text selectable. */}
      <tr
        onClick={() => {
          if ((window.getSelection()?.toString().length ?? 0) > 0) return;
          if (hasDetail) setOpen((v) => !v);
        }}
        style={{ cursor: hasDetail ? "pointer" : "default" }}
      >
        <td style={{ fontWeight: 500, color: "var(--ink)" }}>{o.title ?? "Untitled"}</td>
        <td style={{ color: "var(--ink-2)" }}>{o.agency ?? "-"}</td>
        <td>{o.set_aside ? <span className="tag tag-neutral">{o.set_aside}</span> : <span style={{ color: "var(--ink-3)" }}>-</span>}</td>
        {/* opportunities.fit_score is CHECK BETWEEN 1 AND 10, NOT 0-100, so the
            handoff's ">=70" floor is expressed here as >=7 of 10 (max={10}). */}
        <td style={{ textAlign: "right" }}><ScoreCell score={o.fit_score} max={10} /></td>
        <td>{rec ? <span className={`tag ${REC_TAG[rec] ?? "tag-outline"}`} style={{ textTransform: "capitalize" }}>{rec}</span> : "-"}</td>
        <td className="mono" style={{ fontSize: 12, color: "var(--ink-2)", whiteSpace: "nowrap" }}><LocalTime iso={o.response_deadline} format="date" placeholder="-" /></td>
        {/* When the sweep found it, not when it was last scored: a row re-scored
            today did not arrive today, and "how long has this been sitting here"
            is the question the column answers. */}
        <td className="mono" style={{ fontSize: 12, color: "var(--ink-3)", whiteSpace: "nowrap" }}><LocalTime iso={o.created_at} format="date" placeholder="-" /></td>
        <td style={{ whiteSpace: "nowrap" }}><span className="tag tag-outline">{sourceLabel(o)}</span></td>
        <td onClick={(e) => e.stopPropagation()}>
          {/* stopPropagation: these are decisions, and a click that both triages an
              opportunity and expands the row would make a mis-click ambiguous. */}
          {/* Stacked, not in a row: three verbs side by side widened the column enough
              to squeeze the agency and title cells, which are what a reader scans. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 74 }}>
            {(["pursue", "watch", "ignore"] as const).map((d) => (
              <form key={d} action={setDisposition}>
                <input type="hidden" name="id" value={o.id} />
                <input type="hidden" name="disposition" value={d} />
                <DispositionButton
                  value={d}
                  active={o.disposition === d}
                  label={DISPOSITION_HINT[d]}
                />
              </form>
            ))}
          </div>
        </td>
        <td style={{ textAlign: "right", color: "var(--ink-3)" }}>
          {hasDetail ? (open ? <ChevronUp style={{ width: 14, height: 14 }} /> : <ChevronDown style={{ width: 14, height: 14 }} />) : null}
        </td>
      </tr>
      {open && (
        <tr className="rec-detail-row">
          <td colSpan={10}>
            <div className="rec-detail">
              {o.fit_reason && (
                <div>
                  <div className="rec-detail-label">Fit rationale</div>
                  <div className="rec-detail-body">{o.fit_reason}</div>
                </div>
              )}
              {o.red_flags && (
                <div>
                  <div className="rec-detail-label is-flag">Red flags</div>
                  <div className="rec-detail-body">{o.red_flags}</div>
                </div>
              )}
              {o.bid_gate && (
                <div>
                  {/* A deal that meets none of the gates is flagged like a red flag: it
                      is outside our lane however well it scored. Unknown stays neutral --
                      most rows have never been assessed, and that is not a verdict. */}
                  <div className={`rec-detail-label${o.bid_gate.status === "fail" ? " is-flag" : ""}`}>Bid gates</div>
                  <div className="rec-detail-body">{o.bid_gate.summary}</div>
                </div>
              )}
              <div className="rec-detail-meta">
                {o.source_url && (
                  <span>
                    <a href={o.source_url} target="_blank" rel="noopener noreferrer">
                      View on SAM.gov <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
                    </a>
                  </span>
                )}
                {/* Only pursued opportunities have a folder, so its presence is the
                    signal. No placeholder when absent: "no folder yet" is the normal
                    state for most rows and saying so on every card is noise. */}
                {o.sharepoint_folder_url && (
                  <span>
                    <a href={o.sharepoint_folder_url} target="_blank" rel="noopener noreferrer">
                      Project folder <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
                    </a>
                  </span>
                )}
                {o.solicitation_number && <span>Solicitation <code className="mono">{o.solicitation_number}</code></span>}
                {o.naics_code && <span>NAICS <code className="mono">{o.naics_code}</code></span>}
                {o.last_scored_at && <span>Scored <LocalTime iso={o.last_scored_at} format="date" placeholder="-" /></span>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
