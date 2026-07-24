// Shared HTML/date formatting helpers for email digests.

// Escape HTML-significant characters (& < > ") for safe interpolation into element
// text. Matches the digest renderers (opportunity-report, award-report).
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Format an ISO date as YYYY-MM-DD. Null renders as "TBD"; an unparseable value is
// passed through (HTML-escaped). Used by the award digest.
export function fmtDate(val: string | null): string {
  if (!val) return "TBD";
  const d = new Date(val);
  if (isNaN(d.getTime())) return escapeHtml(val);
  return d.toISOString().slice(0, 10);
}

// Format an ISO deadline as YYYY-MM-DD. Null renders as "-"; an unparseable value is
// passed through (HTML-escaped). Used by the opportunity digest.
export function fmtDeadline(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return escapeHtml(iso);
  return d.toISOString().slice(0, 10);
}
