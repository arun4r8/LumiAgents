// Shared content-hash dedup-ledger machinery for the scored sweeps
// (beady/opportunity-sweep, cleo/award-sweep, beady/industry-day-sweep).
//
// Each sweep fetches candidate items from its own source(s), then avoids re-scoring
// anything it has already scored with unchanged content: it reads a `*_scored` ledger
// of `<key> → content_hash`, keeps only items whose hash is new or changed, LLM-scores
// those, and writes the ledger back. Only that read/filter/write plumbing is genuinely
// identical across the three; the sources, scoring prompts, main-table upserts, and
// per-sweep extras (opportunity-sweep's health alert and demote-to-pass steps) diverge
// enough that a single shared runner would force behaviour changes — so those stay in
// each definition and only this ledger sub-helper is centralized.

import type { RunContext } from "../types";
import { sbHeaders } from "./supabase";

// Load a `<keyColumn> → content_hash` dedup ledger into a Map. Degrades gracefully:
// on any failure it logs via `warnLabel` and returns an empty map, so a ledger outage
// scores everything rather than dropping the run. `profile` targets a non-public
// Postgres schema (omit for the public schema). content_hash may be null in the ledger
// (opportunity-sweep stores rows scored below the save floor with a hash but no score).
export async function loadContentHashLedger(
  ctx: RunContext,
  opts: { table: string; keyColumn: string; profile?: string; warnLabel: string },
): Promise<Map<string, string | null>> {
  const ledger = new Map<string, string | null>();
  try {
    const res = await ctx.fetch(
      `${ctx.env.SUPABASE_URL}/rest/v1/${opts.table}?select=${opts.keyColumn},content_hash`,
      {
        headers:
          opts.profile !== undefined
            ? sbHeaders(ctx.env, { profile: opts.profile })
            : sbHeaders(ctx.env),
      },
    );
    if (res.ok) {
      for (const row of (await res.json()) as Array<Record<string, string | null>>) {
        const key = row[opts.keyColumn];
        if (key) ledger.set(key, row.content_hash ?? null);
      }
    }
  } catch (e) {
    console.warn(opts.warnLabel, e);
  }
  return ledger;
}

// True if an item should be (re-)scored: not in the ledger, or its content hash
// changed since it was last scored (the source item was materially amended).
export function contentChanged(
  ledger: Map<string, string | null>,
  id: string,
  hash: string,
): boolean {
  return !ledger.has(id) || ledger.get(id) !== hash;
}

// Upsert rows into a `*_scored` ledger, merging duplicates on `conflictColumn`. Used
// for the "record everything we just scored" write. Degrades gracefully: a failed
// ledger write is logged (via `warnLabel`) but never throws — the scores are already
// persisted in the main table, so a ledger hiccup only risks a redundant re-score next
// run. Empty `rows` is a no-op. `profile` targets a non-public schema (omit for public).
export async function upsertContentHashLedger(
  ctx: RunContext,
  opts: {
    table: string;
    conflictColumn: string;
    profile?: string;
    rows: Array<Record<string, unknown>>;
    warnLabel: string;
  },
): Promise<void> {
  if (opts.rows.length === 0) return;
  const extra = { Prefer: "resolution=merge-duplicates,return=minimal" };
  const res = await ctx.fetch(
    `${ctx.env.SUPABASE_URL}/rest/v1/${opts.table}?on_conflict=${opts.conflictColumn}`,
    {
      method: "POST",
      headers:
        opts.profile !== undefined
          ? sbHeaders(ctx.env, { profile: opts.profile, extra })
          : sbHeaders(ctx.env, { extra }),
      body: JSON.stringify(opts.rows),
    },
  );
  if (!res.ok) console.warn(`${opts.warnLabel} → ${res.status}: ${await res.text()}`);
}
