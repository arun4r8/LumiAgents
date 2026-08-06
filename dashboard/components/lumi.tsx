"use client";
/**
 * LumiAgents design-system components (client-side only).
 * Import these in Server Components by wrapping in a Suspense boundary or
 * passing to Client Component children.
 */

import React, { useState, useCallback, useSyncExternalStore } from "react";
import { Check, Copy, ChevronRight } from "lucide-react";

// ── Status badge ──────────────────────────────────────────────────────

type Status = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

export function StatusBadge({ status }: { status: string }) {
  const s = status as Status;
  const hasDot = s === "running" || s === "paused" || s === "failed";
  return (
    <span className={`badge ${s}`}>
      {hasDot && <span className="dot" />}
      {s}
    </span>
  );
}

// ── Trigger chip ──────────────────────────────────────────────────────

interface Trigger {
  kind: "cron" | "webhook" | "user" | string;
  label?: string | null;
}

export function TriggerChip({ trigger }: { trigger: Trigger }) {
  const label = trigger?.label ?? trigger?.kind ?? "-";
  const cls =
    trigger?.kind === "cron" ? "chip muted"
    : trigger?.kind === "webhook" ? "chip info"
    : "chip muted";
  return <span className={cls}>{label}</span>;
}

// ── MonoId (copy on click) ────────────────────────────────────────────

export function MonoId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(id).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }, [id]);

  return (
    <span className="mono-id">
      <span className="id-text mono">{id}</span>
      <button className="copy-btn" onClick={copy} title="Copy ID">
        {copied ? <Check /> : <Copy />}
      </button>
    </span>
  );
}

// ── JsonPanel ─────────────────────────────────────────────────────────

export function JsonPanel({
  title,
  value,
  defaultOpen = false,
}: {
  title: string;
  value: unknown;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isEmpty = value == null;

  return (
    <div className="json-pane">
      <div className="jh">
        <span className="ttl">
          {title}
          {isEmpty && <span className="chip muted" style={{ marginLeft: 6, fontSize: 10.5 }}>-</span>}
        </span>
        {!isEmpty && (
          <button
            className="btn ghost sm"
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronRight
              style={{
                width: 12,
                height: 12,
                transition: "transform .15s",
                transform: open ? "rotate(90deg)" : "none",
              }}
            />
            {open ? "Collapse" : "Expand"}
          </button>
        )}
      </div>
      {open && !isEmpty && (
        <pre dangerouslySetInnerHTML={{ __html: colorizeJson(value) }} />
      )}
    </div>
  );
}

function colorizeJson(val: unknown): string {
  const raw = JSON.stringify(val, null, 2) ?? "null";
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="json-str">"$1"</span>')
    .replace(/: (-?\d+\.?\d*)/g, ': <span class="json-num">$1</span>')
    .replace(/: (true|false)/g, ': <span class="json-bool">$1</span>')
    .replace(/: (null)/g, ': <span class="json-null">$1</span>');
}

// ── Time helpers ──────────────────────────────────────────────────────

export function fmtTimeAgo(iso: string | null | undefined): string {
  if (!iso) return "-";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtAbs(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Wall-clock HH:MM:SS in the runtime's local timezone. Like fmtAbs, this is
 *  timezone-dependent (and locale-dependent unless the locale is pinned — we pin
 *  "en-US" so only the timezone can vary), so it must only reach the DOM through
 *  <LocalTime>, never straight into SSR markup. */
export function fmtClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Calendar date only, no time. Timezone-dependent (a UTC instant near midnight
 *  is a different day either side of the line) and locale-dependent unless the
 *  locale is pinned, so like fmtAbs it must reach the DOM through <LocalTime>. */
export function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "numeric", day: "numeric" });
}

export function fmtExpiry(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return "Expired";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `Expires in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Expires in ${h}h`;
  return `Expires in ${Math.floor(h / 24)}d`;
}

export function fmtDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt) return "-";
  const end = endedAt ? new Date(endedAt) : new Date();
  const ms = end.getTime() - new Date(startedAt).getTime();
  if (ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/**
 * Renders a timestamp whose text depends on the viewer's timezone (fmtAbs /
 * fmtClock read the local zone), deferred to the client so it can't cause a
 * hydration mismatch.
 *
 * The trap this closes (#148, then #149's follow-up): the server renders these
 * client components during SSR in UTC, the browser re-renders in the viewer's
 * zone, and the same instant prints different text — React discards the server
 * subtree (minified #418). Gating the value behind a mount flag makes the server
 * and the client's first render both emit `placeholder`, so they agree; the real
 * local time appears one frame later. The placeholder is deliberately a blank
 * marker ("--:--"), never a plausible-but-wrong guess, and the value is never
 * silenced — it is correct local time, just deferred.
 *
 * Only for timezone/locale-dependent text. A stable server-computed string
 * (e.g. a pre-baked "3m ago" prop) needs no gate and should not use this — it
 * would only flash a placeholder for no reason.
 */
export function LocalTime({
  iso,
  format = "abs",
  placeholder = "--:--",
}: {
  iso: string | null | undefined;
  /**
   * "abs"    → fmtAbs (date+time, today-aware)   — timezone-dependent
   * "date"   → fmtDate ("8/15/2026")             — timezone-dependent
   * "clock"  → fmtClock (HH:MM:SS)               — timezone- and locale-dependent
   * "ago"    → fmtTimeAgo ("3m ago")             — clock-dependent
   * "expiry" → fmtExpiry ("Expires in 2h")       — clock-dependent
   *
   * The last two do not read the timezone, but they measure against Date.now(),
   * so they mismatch whenever a minute boundary falls between the server render
   * and hydration. Intermittent rather than constant — and therefore worse to
   * chase, which is why they are gated too.
   */
  format?: "abs" | "clock" | "ago" | "expiry" | "date";
  placeholder?: string;
}): React.ReactElement {
  // useSyncExternalStore is the hydration-safe way to read a client-only value:
  // React uses getServerSnapshot (false) for SSR *and* the first client render,
  // so both sides emit the placeholder and agree, then re-renders with the client
  // snapshot (true). No setState-in-effect, no mismatch.
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);
  if (!mounted) return <>{placeholder}</>;
  const text =
    format === "clock" ? fmtClock(iso)
    : format === "date" ? fmtDate(iso)
    : format === "ago" ? fmtTimeAgo(iso)
    : format === "expiry" ? fmtExpiry(iso)
    : fmtAbs(iso);
  return <>{text ?? placeholder}</>;
}

/**
 * The same server/client snapshot split as LocalTime, for callers that must gate
 * something other than text. An un-gated className derived from the clock is
 * still a hydration mismatch — React just reports it differently than a text
 * one — so styling that depends on "how long is left" needs this too.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(subscribeNoop, () => true, () => false);
}

/**
 * Expiry tag: the label AND the accent class both derive from the clock, so both
 * are gated. Pre-mount it renders neutral with a blank label; urgency appears
 * with the text one frame later.
 */
export function UrgencyTag({ expiresAt }: { expiresAt: string | null | undefined }) {
  const mounted = useMounted();
  if (!expiresAt) return null;
  // Three tiers, matching what the pre-redesign approvals screen escalated to.
  // Collapsing these to one meant an approval with eight minutes left looked the
  // same as one with an hour and fifty, which is the moment the distinction is
  // load-bearing. The label already says how long is left; the colour is what
  // makes it scannable down a list.
  const expiring = mounted && isExpiring(expiresAt);
  const urgent = mounted && isUrgent(expiresAt);
  const tier = expiring ? "tag-danger" : urgent ? "tag-accent" : "tag-neutral";
  return (
    <span className={`tag ${tier}`}>
      <LocalTime iso={expiresAt} format="expiry" placeholder="" />
    </span>
  );
}

/**
 * Run duration. A SETTLED run is arithmetic on two fixed instants — fully
 * deterministic, so it renders immediately with no placeholder. Only an
 * in-flight run measures against Date.now() and needs the gate. Gating the
 * settled case would flash a placeholder for nothing.
 */
export function LiveDuration({
  startedAt,
  endedAt,
}: {
  startedAt: string | null;
  endedAt: string | null;
}) {
  const mounted = useMounted();
  if (!startedAt || endedAt) return <>{fmtDuration(startedAt, endedAt)}</>;
  return <>{mounted ? fmtDuration(startedAt, endedAt) : "-"}</>;
}

/** Urgent = under two hours left; the tag flips to accent per the spec.
 *  Clock-dependent — reach it through <UrgencyTag>, not directly in JSX. */
export function isUrgent(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const ms = new Date(iso).getTime() - Date.now();
  return ms >= 0 && ms < 2 * 60 * 60 * 1000;
}

/** Expiring = under thirty minutes left, the tier above urgent. Note this stays
 *  true right down to zero and goes false once expired, so an already-dead
 *  approval reads as neutral with an "Expired" label rather than shouting.
 *  Clock-dependent — reach it through <UrgencyTag>, not directly in JSX. */
export function isExpiring(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const ms = new Date(iso).getTime() - Date.now();
  return ms >= 0 && ms < 30 * 60 * 1000;
}

/** A store that never changes — LocalTime only needs the server/client snapshot
 *  split, not live updates, so the subscribe callback is a no-op. */
function subscribeNoop(): () => void {
  return () => {};
}
