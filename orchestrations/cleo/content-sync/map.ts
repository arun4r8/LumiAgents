// Port of dashboard/lib/content-csv.ts's grid→rows mapping, adapted to take a
// pre-parsed string[][] grid (as returned by the Microsoft Graph workbook API)
// instead of raw CSV text. The header matching, date parsing, and — critically —
// the `source_key` derivation are kept byte-identical to content-csv.ts so a row
// synced from Graph collides on the same key as the same row imported from CSV
// (both `onConflict: source_key`), and the two paths stay interchangeable.

import { fnv1a } from "@/runtime/utils/hash";

export interface ContentRow {
  source_key: string;
  release_date: string | null;
  topic: string;
  channel: string;
  asset_type: string | null;
  asset_ref: string | null;
  description: string | null;
  owner: string | null;
}

// ─── Header → field mapping (flexible, case-insensitive) ────────────────────────
function matchHeader(headers: string[], patterns: RegExp[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!.toLowerCase().trim();
    if (patterns.some((p) => p.test(h))) return i;
  }
  return -1;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Best-effort date → YYYY-MM-DD. Handles ISO, M/D/Y, and D-Mon / Mon D (assumes a
// sensible year when the source omits it). Returns null if unparseable.
export function parseDate(raw: string, thisYear: number): string | null {
  const v = raw.trim();
  if (!v) return null;
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2]!.padStart(2, "0")}-${iso[3]!.padStart(2, "0")}`;
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const y = us[3]!.length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    return `${y}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  }
  // "7-Jul", "7 Jul", "Jul 7", "July 7"
  const dMon = v.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})/);
  const monD = v.match(/^([A-Za-z]{3,})[\s-]+(\d{1,2})/);
  let day: number | null = null, mon: number | null = null;
  if (dMon) { day = Number(dMon[1]); mon = MONTHS[dMon[2]!.slice(0, 3).toLowerCase()] ?? null; }
  else if (monD) { mon = MONTHS[monD[1]!.slice(0, 3).toLowerCase()] ?? null; day = Number(monD[2]); }
  if (day && mon) {
    const yMatch = v.match(/\b(20\d{2})\b/);
    const year = yMatch ? Number(yMatch[1]) : thisYear;
    return `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const parsed = new Date(v);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

// Map a worksheet grid (header row first) into content_calendar upsert rows.
// Mirrors mapContentCsv: `topic` is required; a missing topic skips the row.
export function mapGridToRows(grid: string[][], thisYear: number): { rows: ContentRow[]; skipped: number } {
  if (grid.length < 2) return { rows: [], skipped: 0 };
  const headers = grid[0]!;
  const col = {
    id: matchHeader(headers, [/^id$/, /^row ?id$/]),
    date: matchHeader(headers, [/release/, /\bdate\b/, /publish/]),
    topic: matchHeader(headers, [/topic/, /title/, /subject/]),
    asset: matchHeader(headers, [/asset/, /graphic/, /image/, /file/]),
    assetType: matchHeader(headers, [/asset ?type/, /type/, /format/]),
    desc: matchHeader(headers, [/description/, /text/, /brief/, /copy/, /caption/]),
    channel: matchHeader(headers, [/channel/, /platform/]),
    owner: matchHeader(headers, [/owner/, /assigned/, /author/]),
  };
  const get = (r: string[], i: number) => (i >= 0 && r[i] != null ? r[i]!.trim() : "");

  const rows: ContentRow[] = [];
  let skipped = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]!;
    const topic = get(r, col.topic);
    if (!topic) { skipped++; continue; } // topic is required
    const release = parseDate(get(r, col.date), thisYear);
    const channel = get(r, col.channel) || "linkedin";
    const explicitId = get(r, col.id);
    const source_key = explicitId
      ? `csv:${explicitId}`
      : `csv:${fnv1a(`${topic.toLowerCase()}|${release ?? ""}|${channel.toLowerCase()}`)}`;
    rows.push({
      source_key,
      release_date: release,
      topic,
      channel,
      asset_type: get(r, col.assetType) || null,
      asset_ref: get(r, col.asset) || null,
      description: get(r, col.desc) || null,
      owner: get(r, col.owner) || null,
    });
  }
  return { rows, skipped };
}
