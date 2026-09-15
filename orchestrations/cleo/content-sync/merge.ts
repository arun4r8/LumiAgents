// Pure planning logic for the two-way content-calendar sync. Given the current
// sheet rows and db rows, `planSync` produces a fully-resolved set of writes (sheet
// cell updates, table-row appends, db inserts/updates) plus per-category counts and
// a human-readable plan. It performs NO I/O and generates ids only through the
// injected `genId`, so the caller can memoize them inside a durable step (and tests
// can pass a deterministic generator).
//
// Reconciliation model — 3-way merge with app-wins:
//   For each synced field (topic, description, asset_ref) we compare the sheet value
//   and the app value against the last-synced snapshot (`sync_base`, the shared
//   ancestor):
//     both changed  → APP WINS (and we count a conflict); the app value is written
//                     back over the sheet.
//     only app      → app value flows to the sheet (push).
//     only sheet    → sheet value flows to the app (pull).
//     neither       → no-op.
//   The resolved values become the new `sync_base`.
//
// Origin/adoption rules:
//   * A sheet row with a matching db row (by sheet_id === sheet.id) → 3-way merge.
//   * A sheet row with a blank id whose topic hashes to a legacy one-way `source_key`
//     (`csv:<fnv1a>`) adopts that db row: it is linked (new id backfilled to the
//     sheet, source_key rewritten to `sheet:<id>`) instead of duplicated.
//   * Any other sheet row with a topic → NEW APP ROW (insert; id backfilled to sheet).
//   * A db row that never came from the sheet (source_key IS NULL, no sheet link) →
//     NEW SHEET ROW (appended; its generated id written inline).
//   * A db row linked to a sheet row that has since disappeared → left untouched
//     (no delete propagation, either direction).

import { fnv1a } from "@/runtime/utils/hash";

export type SyncField = "topic" | "description" | "asset_ref";
export const SYNC_FIELDS: readonly SyncField[] = ["topic", "description", "asset_ref"];

/** A row read from the Excel table, coerced to trimmed strings ("" = empty cell). */
export interface SheetRow {
  rowIndex: number;      // 0-based index within the table's data rows
  sheetRow: number;      // absolute 1-based worksheet row (for cell addresses)
  id: string;            // the sheet's `id` column ("" when blank)
  topic: string;
  description: string;
  asset_ref: string;
}

/** A row read from public.content_calendar. */
export interface DbRow {
  id: string;
  sheet_id: string | null;
  source_key: string | null;
  topic: string | null;
  description: string | null;
  asset_ref: string | null;
  sync_base: Partial<Record<SyncField, string>> | null;
}

/** Where each synced field lives in the sheet, so the planner can build addresses. */
export interface SheetLayout {
  /** Absolute column letters (e.g. "D") for each field + the id column. */
  colLetters: Record<SyncField | "id", string>;
  /** Total number of columns in the table (for building full append rows). */
  headerLen: number;
  /** 0-based index of each field + id within the table's header row. */
  headerIndex: Record<SyncField | "id", number>;
}

export interface PlanOptions {
  layout: SheetLayout;
  genId: () => string;
}

export interface SheetCellUpdate {
  address: string; // e.g. "E12"
  value: string;
}
export interface SheetRowAdd {
  values: string[]; // full row in header order, id filled inline
}
export interface DbInsert {
  row: Record<string, unknown>;
}
export interface DbUpdate {
  id: string;
  patch: Record<string, unknown>;
}
export interface PlanEntry {
  action: string;
  sheetId: string;
  topic: string;
  fields?: SyncField[];
}

export interface SyncCounts {
  pulledFromSheet: number; // rows whose app content came from the sheet (inserts + sheet-wins merges)
  pushedToSheet: number;   // rows whose sheet content came from the app (appends + app-wins merges)
  updatedInApp: number;    // existing matched rows updated because the sheet value won
  updatedInSheet: number;  // existing matched rows whose cells were rewritten because the app value won
  idsBackfilled: number;   // id cells written into pre-existing sheet rows (adoptions + new app rows)
  conflicts: number;       // per-field both-sides-changed resolutions (app won)
  newSheetRows: number;    // app-origin rows appended to the sheet
  newAppRows: number;      // sheet-origin rows inserted into the app
  skipped: number;         // rows skipped because the merged topic went empty
}

/**
 * How many entries of the human-readable plan a dry run shows.
 *
 * This is a DISPLAY cap and nothing else. The arrays above it -- the ones that
 * actually drive writes -- are deliberately uncapped, because truncating the work
 * would silently half-sync a sheet.
 *
 * That distinction used to be invisible: `plan` was sliced to 100 with no note, so
 * a dry run against a 400-row sheet reported 100 actions and the real run issued
 * 400. A preview that understates the work is worse than no preview, because it is
 * believed. `planTotal` and `planTruncated` now travel with it.
 */
export const PLAN_PREVIEW_LIMIT = 100;

export interface SyncPlan {
  idBackfills: SheetCellUpdate[];
  sheetCellUpdates: SheetCellUpdate[];
  sheetRowAdds: SheetRowAdd[];
  dbInserts: DbInsert[];
  dbUpdates: DbUpdate[];
  counts: SyncCounts;
  /** A SAMPLE of the actions, at most PLAN_PREVIEW_LIMIT. See planTotal. */
  plan: PlanEntry[];
  /** How many actions there really are. Always the full number. */
  planTotal: number;
  /** True when `plan` is a sample rather than the whole list. */
  planTruncated: boolean;
}

const norm = (v: string | null | undefined): string => v ?? "";

// The legacy one-way sync keyed non-id rows as
//   csv:${fnv1a(`${topic.toLowerCase()}|${release ?? ""}|${channel.toLowerCase()}`)}
// These sheet rows have no real date (release = null → "") and default channel
// "linkedin", so the ancestor key is fnv1a("<topic>||linkedin").
export function legacySourceKey(topic: string): string {
  return `csv:${fnv1a(`${topic.toLowerCase()}||linkedin`)}`;
}

export function planSync(sheetRows: SheetRow[], dbRows: DbRow[], opts: PlanOptions): SyncPlan {
  const { layout, genId } = opts;

  const counts: SyncCounts = {
    pulledFromSheet: 0,
    pushedToSheet: 0,
    updatedInApp: 0,
    updatedInSheet: 0,
    idsBackfilled: 0,
    conflicts: 0,
    newSheetRows: 0,
    newAppRows: 0,
    skipped: 0,
  };
  const plan: SyncPlan = {
    idBackfills: [],
    sheetCellUpdates: [],
    sheetRowAdds: [],
    dbInserts: [],
    dbUpdates: [],
    counts,
    plan: [],
    planTotal: 0,
    planTruncated: false,
  };

  const bySheetId = new Map<string, DbRow>();
  for (const r of dbRows) if (r.sheet_id) bySheetId.set(r.sheet_id, r);

  const consumed = new Set<string>(); // db rows already matched/adopted this pass

  const idAddress = (sheetRow: number) => `${layout.colLetters.id}${sheetRow}`;

  // ── insert a new app row from a sheet row (optionally reusing an existing id) ──
  const newAppRow = (s: SheetRow, existingId: string | null): void => {
    const id = existingId ?? genId();
    if (!existingId) {
      plan.idBackfills.push({ address: idAddress(s.sheetRow), value: id });
      counts.idsBackfilled++;
    }
    plan.dbInserts.push({
      row: {
        topic: s.topic,
        description: s.description === "" ? null : s.description,
        asset_ref: s.asset_ref === "" ? null : s.asset_ref,
        status: "idea",
        channel: "linkedin",
        sheet_id: id,
        source_key: `sheet:${id}`,
        sync_base: { topic: s.topic, description: s.description, asset_ref: s.asset_ref },
      },
    });
    counts.newAppRows++;
    counts.pulledFromSheet++;
    plan.plan.push({ action: "new-app-row", sheetId: id, topic: s.topic });
  };

  // ── link a legacy db row to a sheet row without touching content ──────────────
  const adopt = (s: SheetRow, db: DbRow, existingId: string | null = null): void => {
    // existingId: the sheet row already carries an id, written by an earlier run that
    // died before it linked the app row. Reuse it; writing a second id would orphan
    // the first.
    const newId = existingId ?? genId();
    if (!existingId) {
      plan.idBackfills.push({ address: idAddress(s.sheetRow), value: newId });
      counts.idsBackfilled++;
    }
    // Baseline the snapshot to the app's current values; the next run diffs cleanly
    // and any genuine sheet edit then flows in as a normal 3-way pull.
    const base = { topic: norm(db.topic), description: norm(db.description), asset_ref: norm(db.asset_ref) };
    plan.dbUpdates.push({
      id: db.id,
      patch: { sheet_id: newId, source_key: `sheet:${newId}`, sync_base: base },
    });
    plan.plan.push({ action: "adopt-legacy", sheetId: newId, topic: base.topic });
  };

  // An unlinked legacy one-way row whose key is this topic's hash.
  const legacyFor = (topic: string): DbRow | undefined =>
    dbRows.find((r) => r.sheet_id == null && !consumed.has(r.id) && r.source_key === legacySourceKey(topic));

  // ── 3-way merge a matched sheet row against its db row ────────────────────────
  const mergeMatched = (s: SheetRow, db: DbRow): void => {
    const resolved: Record<SyncField, string> = { topic: "", description: "", asset_ref: "" };
    const changedFields: SyncField[] = [];
    const sheetUpdates: Array<{ field: SyncField; value: string }> = [];
    const dbFieldPatch: Record<string, unknown> = {};
    let dbFieldChanges = 0;
    let rowConflicts = 0;

    for (const f of SYNC_FIELDS) {
      const base = norm(db.sync_base?.[f]);
      const sheetVal = norm(s[f]);
      const appVal = norm(db[f]);
      const sheetChanged = sheetVal !== base;
      const appChanged = appVal !== base;

      let res: string;
      if (sheetChanged && appChanged) {
        res = appVal; // app wins
        rowConflicts++;
      } else if (appChanged) {
        res = appVal;
      } else if (sheetChanged) {
        res = sheetVal;
      } else {
        res = base;
      }
      resolved[f] = res;
      if (res !== base) changedFields.push(f);
      if (res !== sheetVal) sheetUpdates.push({ field: f, value: res });
      if (res !== appVal) {
        dbFieldPatch[f] = f === "topic" ? res : res === "" ? null : res;
        dbFieldChanges++;
      }
    }

    // topic must never go empty; skip the row rather than corrupt it.
    if (resolved.topic === "") {
      counts.skipped++;
      plan.plan.push({ action: "skip-empty-topic", sheetId: s.id, topic: norm(db.topic) });
      return;
    }

    for (const u of sheetUpdates) {
      plan.sheetCellUpdates.push({ address: `${layout.colLetters[u.field]}${s.sheetRow}`, value: u.value });
    }

    const anyChange = sheetUpdates.length > 0 || dbFieldChanges > 0;
    if (anyChange) {
      plan.dbUpdates.push({
        id: db.id,
        patch: {
          ...dbFieldPatch,
          sync_base: { topic: resolved.topic, description: resolved.description, asset_ref: resolved.asset_ref },
        },
      });
      if (dbFieldChanges > 0) {
        counts.updatedInApp++;
        counts.pulledFromSheet++;
      }
      if (sheetUpdates.length > 0) {
        counts.updatedInSheet++;
        counts.pushedToSheet++;
      }
      const action =
        dbFieldChanges > 0 && sheetUpdates.length > 0
          ? "merge"
          : sheetUpdates.length > 0
            ? "push-to-sheet"
            : "pull-from-sheet";
      plan.plan.push({ action, sheetId: s.id, topic: resolved.topic, fields: changedFields });
    }
    counts.conflicts += rowConflicts;
  };

  // ── Pass 1: every (non-spacer) sheet row ──────────────────────────────────────
  for (const s of sheetRows) {
    if (!s.topic && !s.id) continue; // blank spacer row → ignore

    if (s.id) {
      const db = bySheetId.get(s.id);
      if (db && !consumed.has(db.id)) {
        consumed.add(db.id);
        mergeMatched(s, db);
        continue;
      }
      if (s.topic) {
        // A sync writes the sheet BEFORE the app. If a run dies in between -- as the
        // 2026-09-14 run did, on a NOT NULL violation in write-db -- the sheet holds
        // ids no app row records. Read naively, that looks like "the app row was
        // deleted", and re-materializing would insert a duplicate of every row while
        // the originals sat unlinked. So adopt the unlinked legacy row first, keeping
        // the id the sheet already has; only a row with no such twin is a deletion.
        const orphaned = legacyFor(s.topic);
        if (orphaned) {
          consumed.add(orphaned.id);
          adopt(s, orphaned, s.id);
          continue;
        }
        // Genuinely gone from the app: re-materialize it, reusing the sheet id.
        newAppRow(s, s.id);
      }
      continue;
    }

    // Blank id + a topic: try to adopt a legacy one-way row, else insert new.
    const adoptee = legacyFor(s.topic);
    if (adoptee) {
      consumed.add(adoptee.id);
      adopt(s, adoptee);
      continue;
    }
    newAppRow(s, null);
  }

  // ── Pass 2: app-origin db rows with no sheet counterpart → append to the sheet ─
  for (const db of dbRows) {
    if (consumed.has(db.id)) continue;
    if (db.sheet_id) continue;         // linked already, or removed-from-sheet → leave it
    if (db.source_key !== null) continue; // legacy/sheet-derived, not app-origin
    const newId = genId();
    const base = { topic: norm(db.topic), description: norm(db.description), asset_ref: norm(db.asset_ref) };
    const values = new Array<string>(layout.headerLen).fill("");
    values[layout.headerIndex.topic] = base.topic;
    values[layout.headerIndex.description] = base.description;
    values[layout.headerIndex.asset_ref] = base.asset_ref;
    values[layout.headerIndex.id] = newId;
    plan.sheetRowAdds.push({ values });
    plan.dbUpdates.push({
      id: db.id,
      patch: { sheet_id: newId, source_key: `sheet:${newId}`, sync_base: base },
    });
    counts.newSheetRows++;
    counts.pushedToSheet++;
    plan.plan.push({ action: "new-sheet-row", sheetId: newId, topic: base.topic });
  }

  // Record the true size BEFORE trimming the preview, so the caller can never
  // mistake the sample for the whole.
  plan.planTotal = plan.plan.length;
  plan.planTruncated = plan.plan.length > PLAN_PREVIEW_LIMIT;
  plan.plan = plan.plan.slice(0, PLAN_PREVIEW_LIMIT);
  return plan;
}

/**
 * The rows write-db upserts for plan.dbUpdates.
 *
 * write-db sends the updates as ONE upsert (POST ?on_conflict=id, merge-duplicates),
 * which Postgres runs as INSERT ... ON CONFLICT DO UPDATE. The NOT NULL check runs on
 * the proposed INSERT row BEFORE the conflict is found, so a patch that omits
 * `topic` -- every adoption and every new-sheet-row link does -- is rejected even
 * though the row exists and has a topic. That rejected the whole batch of 13 on the
 * first real run (2026-09-14), after the sheet had already been written.
 *
 * So each row carries the topic it already has, unless the patch changes it. It is
 * the only NOT NULL column without a default (id, channel, status and the
 * timestamps all have one). Throws rather than sending a row it knows will fail:
 * a topic-less update means the plan and the database disagree, which is worth
 * stopping on.
 */
export function dbUpsertRows(
  updates: SyncPlan["dbUpdates"],
  dbRows: DbRow[],
  now: string,
): Array<Record<string, unknown>> {
  const byId = new Map(dbRows.map((r) => [r.id, r]));
  return updates.map((u) => {
    const patched = u.patch["topic"];
    const topic = typeof patched === "string" && patched !== "" ? patched : byId.get(u.id)?.topic;
    if (!topic) {
      throw new Error(
        `content-sync: no topic for content_calendar row ${u.id}. The upsert would violate NOT NULL, so it is not sent.`,
      );
    }
    return { id: u.id, ...u.patch, topic, updated_at: now };
  });
}
