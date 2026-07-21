"use client";
/**
 * LumiAgents design-system components (client-side only).
 * Import these in Server Components by wrapping in a Suspense boundary or
 * passing to Client Component children.
 */

import React, { useState, useCallback } from "react";
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
