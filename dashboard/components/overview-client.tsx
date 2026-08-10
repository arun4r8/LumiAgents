"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AgentMark } from "@/components/agent-mark";
import { agentInk } from "@/lib/agent-style";
import { useMounted, UrgencyTag } from "@/components/lumi";

/**
 * Overview — hero, stat band, fleet, throughput, recent activity.
 *
 * ── On the design's "Live stream" ────────────────────────────────────────────
 * The handoff asks for a live stream whose "new events prepend in real time
 * (Supabase realtime — see overview-realtime.tsx)". That is not deliverable:
 * `supabase_realtime` publishes ZERO tables in production (verified; issue #142),
 * no migration has ever run `ALTER PUBLICATION supabase_realtime ADD TABLE`, and
 * publishing them is out of scope for this phase. The old subscription connected
 * happily and then never received an event, under a header that said "Live · UTC"
 * with a pulsing dot — a screen that looked alive and was frozen.
 *
 * So this panel is a POLLED recent-activity list, and it says so:
 *   · the heading is "Recent activity", not "Live", and there is no pulsing dot;
 *   · `router.refresh()` re-runs the server component every 30s, which re-reads
 *     runs / run_steps / approvals through RLS — the same path a manual reload
 *     takes, so nothing can be shown that the viewer could not otherwise read;
 *   · a mono footnote states the interval and when the data was last read.
 * `components/overview-realtime.tsx` is deleted rather than left in place: a
 * component that implies liveness it cannot deliver is the bug in #142.
 *
 * The one animation on this screen is the pulsing dot on a RUNNING fleet tile —
 * genuinely live state — and it stops under prefers-reduced-motion.
 */

// ─── Props ────────────────────────────────────────────────────────────────────

export interface FleetAgent {
  slug: string;
  name: string;
  domain: string;
  state: "running" | "blocked" | "idle";
  sub: string;
}

export interface ThroughputBucket {
  runs: number;
  failed: number;
}

export interface StreamEvent {
  id: string;
  at: string | null;
  /** Owning agent slug, or null for `system/…` orchestrations. */
  agent: string | null;
  status: string;
  message: string;
}

export interface UrgentApproval {
  id: string;
  prompt: string;
  createdAt: string;
  expiresAt: string | null;
  runId: string | null;
  orchestration: string;
}

interface OverviewClientProps {
  /** The few soonest-expiring pending approvals, for the inline decide panel. */
  urgent: UrgentApproval[];
  decideApproval: (formData: FormData) => Promise<void>;
  working: number;
  pending: number;
  failed24: number;
  weekRuns: number;
  /** Share of settled runs that completed cleanly; null when nothing settled. */
  cleanPct: number | null;
  spendLabel: string;
  fleet: FleetAgent[];
  buckets: ThroughputBucket[];
  stream: StreamEvent[];
}

const POLL_MS = 30_000;

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function OverviewClient({
  urgent,
  decideApproval,
  working,
  pending,
  failed24,
  weekRuns,
  cleanPct,
  spendLabel,
  fleet,
  buckets,
  stream,
}: OverviewClientProps) {
  const { readAt, refreshNow } = usePolledRefresh();
  const mounted = useMounted();

  return (
    <div className="page view-fade">
      <header className="ov-hero">
        <h1>{heroLine(working)}</h1>
        <p>
          {failed24 === 0
            ? "Nothing failed in the last 24 hours"
            : `${failed24} ${failed24 === 1 ? "run" : "runs"} failed in the last 24 hours`}
          {" · "}
          {pending === 0
            ? "nothing waiting on you, all caught up"
            : `${pending} ${pending === 1 ? "approval" : "approvals"} waiting on you`}
        </p>
      </header>

      <div className="ov-stats">
        <Stat value={weekRuns.toLocaleString()} label="runs this week" href="/runs" />
        <Stat
          value={cleanPct == null ? "-" : cleanPct.toFixed(1)}
          unit={cleanPct == null ? undefined : "%"}
          label="completed without intervention"
          href="/runs"
        />
        <Stat value={String(pending)} label="pending approvals" accent href="/approvals" />
        <Stat value={spendLabel} label="LLM spend · 7 days" href="/infrastructure" />
      </div>

      {urgent.length > 0 && (
        <section className="ov-needs">
          <div className="ov-needs-h">
            <h2 className="ov-sec">What needs you</h2>
            <Link className="ov-more" href="/approvals">
              Approvals ({pending}) →
            </Link>
          </div>
          {urgent.map((a) => (
            <MiniApproval key={a.id} approval={a} decide={decideApproval} />
          ))}
        </section>
      )}

      <div className="ov-cols">
        <div className="ov-col">
          <h2 className="ov-sec">The fleet</h2>
          {fleet.length === 0 ? (
            <p className="ov-empty">
              No agents are on staff yet. Ops can add one from Agents → New agent.
            </p>
          ) : (
            <div className="ov-fleet">
              {fleet.map((a) => (
                <FleetTile key={a.slug} agent={a} />
              ))}
            </div>
          )}

          <h2 className="ov-sec is-second">Throughput · 24h</h2>
          <Throughput buckets={buckets} />
        </div>

        <div className="ov-col">
          <h2 className="ov-sec">Recent activity</h2>
          {stream.length === 0 ? (
            <p className="ov-empty">
              No steps have run recently. Start something from an agent chat or from
              Orchestrations and it will show up here.
            </p>
          ) : (
            <div className="ov-stream">
              {stream.map((ev) => (
                <ActivityRow key={ev.id} event={ev} mounted={mounted} />
              ))}
            </div>
          )}
          {/* Deliberately plain about how fresh this is — see the note above. */}
          <p className="ov-note">
            {readAt && `last read ${readAt} · `}refreshes every {POLL_MS / 1000}s
            {" · "}
            <button type="button" className="ov-refresh" onClick={refreshNow}>
              Refresh now
            </button>
          </p>
          <Link className="ov-more" href="/runs">
            All runs →
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Stat band ────────────────────────────────────────────────────────────────

/**
 * A stat, optionally a link.
 *
 * The pre-redesign Overview made every KPI a route into the screen that
 * explains it, and the redesign flattened them to plain text. That removed the
 * obvious next click from the first screen an ops user sees, so the numbers are
 * navigation again wherever there is somewhere sensible to go.
 */
function Stat({
  value,
  unit,
  label,
  accent,
  href,
}: {
  value: string;
  unit?: string;
  label: string;
  accent?: boolean;
  href?: string;
}) {
  const body = (
    <>
      <div className={accent ? "ov-stat-v is-accent" : "ov-stat-v"}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      <div className="ov-stat-l">{label}</div>
    </>
  );
  if (!href) return <div>{body}</div>;
  return (
    <Link href={href} className="ov-stat-link">
      {body}
    </Link>
  );
}

/**
 * One pending approval, decidable in place.
 *
 * Deliberately not a full replica of the Approvals screen: no history, no
 * filters, no decided rows. This is the "you are three clicks from unblocking a
 * run" affordance, and anything more would be a second Approvals page drifting
 * out of sync with the first. The note field is optional here for the same
 * reason; a considered rationale belongs on the screen built for it.
 *
 * Urgency styling comes from <UrgencyTag>, so this picks up the same three
 * tiers the Approvals screen uses rather than inventing a fourth.
 */
function MiniApproval({
  approval,
  decide,
}: {
  approval: UrgentApproval;
  decide: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={decide} className="ov-appr">
      <input type="hidden" name="approvalId" value={approval.id} />
      <div className="ov-appr-head">
        <span className="ov-appr-orch">{approval.orchestration}</span>
        <UrgencyTag expiresAt={approval.expiresAt} />
      </div>
      <p className="ov-appr-prompt">{approval.prompt}</p>
      <div className="ov-appr-actions">
        <input
          className="input ov-appr-note"
          type="text"
          name="notes"
          placeholder="Optional note"
        />
        <button className="btn accent sm" type="submit" name="status" value="approved">
          Approve
        </button>
        <button className="btn sm" type="submit" name="status" value="rejected">
          Reject
        </button>
        {approval.runId && (
          <Link className="btn ghost sm" href={`/runs/${approval.runId}`}>
            Open run
          </Link>
        )}
      </div>
    </form>
  );
}

// ─── Fleet ────────────────────────────────────────────────────────────────────

function FleetTile({ agent }: { agent: FleetAgent }) {
  return (
    <Link className="ov-tile" href={`/agents/${agent.slug}`}>
      <AgentMark slug={agent.slug} name={agent.name} size={34} />
      <span className="ov-tile-id">
        <span className="ov-tile-name">
          {agent.name} <span className="dom">· {agent.domain}</span>
        </span>
        <span className={`ov-tile-sub is-${agent.state}`}>{agent.sub}</span>
      </span>
      <span className={`ov-state is-${agent.state}`}>
        <span className="dot" aria-hidden="true" />
        {agent.state}
      </span>
    </Link>
  );
}

// ─── Throughput ───────────────────────────────────────────────────────────────

function Throughput({ buckets }: { buckets: ThroughputBucket[] }) {
  const max = Math.max(...buckets.map((b) => b.runs), 1);
  return (
    <>
      <div className="ov-thru" role="img" aria-label="Runs per hour over the last 24 hours">
        {buckets.map((b, i) => {
          // Bars read newest-last. A bucket with a failure takes the failure
          // tone; otherwise the three most recent hours brighten toward now.
          const fromEnd = buckets.length - 1 - i;
          const tone = b.failed > 0
            ? " is-failed"
            : fromEnd < 3
            ? ` is-h${fromEnd + 1}`
            : "";
          return (
            <i
              key={i}
              className={tone.trim() || undefined}
              style={{ height: `${Math.max((b.runs / max) * 100, b.runs > 0 ? 6 : 3)}%` }}
            />
          );
        })}
      </div>
      <div className="ov-axis">
        <span>-24h</span>
        <span>-12h</span>
        <span>now</span>
      </div>
    </>
  );
}

// ─── Recent activity ──────────────────────────────────────────────────────────

function ActivityRow({ event, mounted }: { event: StreamEvent; mounted: boolean }) {
  const tone =
    event.status === "failed" ? " is-failed" : event.status === "running" ? " is-running" : "";
  return (
    <div className="ov-ev">
      <span className="ov-ev-t">{clock(event.at, mounted)}</span>
      {event.agent && (
        <span className="ov-ev-a" style={{ color: agentInk(event.agent) }}>
          {event.agent}
        </span>
      )}
      <span className={`ov-ev-m${tone}`} title={event.message}>
        {event.message}
      </span>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function heroLine(working: number): string {
  if (working === 0) return "No agents are working right now.";
  if (working === 1) return "1 agent is working right now.";
  return `${working} agents are working right now.`;
}

/**
 * Local wall-clock HH:MM for an event timestamp. getHours()/getMinutes() read
 * the runtime's timezone, so the same ISO renders as e.g. 02:47 under the
 * server's UTC but 19:47 in a Pacific browser — a hydration text mismatch
 * (React #418) if emitted during SSR. `mounted` is false on the server and on
 * the client's first (hydrating) render, so both sides paint the "--:--"
 * placeholder and agree; the real local time appears once the mount effect
 * flips it. (#148)
 */
function clock(iso: string | null, mounted: boolean): string {
  if (!mounted || !iso) return "--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Re-run the server component every POLL_MS and report when it last happened.
 * `router.refresh()` keeps the whole read inside the RLS-scoped server render —
 * there is no second, differently-authorised data path.
 *
 * Returns null until the first poll fires: the initial data was read during the
 * server render, and stamping a client clock onto it in the effect body would
 * both cascade a render and print a time that isn't when the data was read.
 */
function usePolledRefresh(): { readAt: string | null; refreshNow: () => void } {
  const router = useRouter();
  const [readAt, setReadAt] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      router.refresh();
      setReadAt(stamp());
    }, POLL_MS);
    return () => clearInterval(id);
  }, [router]);

  // The poll is every 30s, which is a long time to stare at a screen wondering
  // whether the thing you just triggered has landed. The pre-redesign Overview
  // had a Refresh button and this restores it. Safe to call during an event
  // handler: stamp() only runs on a click, never during render.
  const refreshNow = useCallback(() => {
    router.refresh();
    setReadAt(stamp());
  }, [router]);

  return { readAt, refreshNow };
}

function stamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}`;
}
