import { describe, it, expect } from "vitest";
import {
  planSync,
  legacySourceKey,
  type DbRow,
  type SheetRow,
  type SheetLayout,
} from "../../../orchestrations/cleo/content-sync/merge";

// Sheet shape: Week | Date | Content Pillar | Topic | Caption Summary | Graphic Recommendation | Status | id
// (0-based)     0      1         2              3           4                    5                  6      7
const LAYOUT: SheetLayout = {
  colLetters: { id: "H", topic: "D", description: "E", asset_ref: "F" },
  headerLen: 8,
  headerIndex: { id: 7, topic: 3, description: 4, asset_ref: 5 },
};

// Deterministic id generator so assertions are stable.
function counter(prefix = "gen"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function sheetRow(partial: Partial<SheetRow> & { topic?: string; id?: string }): SheetRow {
  return {
    rowIndex: 0,
    sheetRow: 5,
    id: "",
    topic: "",
    description: "",
    asset_ref: "",
    ...partial,
  };
}

function dbRow(partial: Partial<DbRow> & { id: string }): DbRow {
  return {
    sheet_id: null,
    source_key: null,
    topic: null,
    description: null,
    asset_ref: null,
    sync_base: null,
    ...partial,
  };
}

const opts = () => ({ layout: LAYOUT, genId: counter() });

describe("planSync", () => {
  it("new sheet row (blank id) → app insert + id backfill", () => {
    const s = sheetRow({ topic: "Launch post", description: "teaser", asset_ref: "hero.png" });
    const plan = planSync([s], [], opts());

    expect(plan.dbInserts).toHaveLength(1);
    expect(plan.dbInserts[0]!.row).toMatchObject({
      topic: "Launch post",
      description: "teaser",
      asset_ref: "hero.png",
      status: "idea",
      channel: "linkedin",
      sheet_id: "gen-1",
      source_key: "sheet:gen-1",
      sync_base: { topic: "Launch post", description: "teaser", asset_ref: "hero.png" },
    });
    expect(plan.idBackfills).toEqual([{ address: "H5", value: "gen-1" }]);
    expect(plan.sheetRowAdds).toHaveLength(0);
    expect(plan.dbUpdates).toHaveLength(0);
    expect(plan.counts).toMatchObject({ newAppRows: 1, idsBackfilled: 1, pulledFromSheet: 1 });
  });

  it("app-origin row (source_key null, no link) → new sheet row + db linkage", () => {
    const db = dbRow({ id: "db1", topic: "App idea", description: "body", asset_ref: null });
    const plan = planSync([], [db], opts());

    expect(plan.sheetRowAdds).toHaveLength(1);
    const values = plan.sheetRowAdds[0]!.values;
    expect(values).toHaveLength(8);
    expect(values[3]).toBe("App idea"); // Topic
    expect(values[4]).toBe("body");     // Caption Summary
    expect(values[5]).toBe("");         // Graphic Recommendation (null → "")
    expect(values[7]).toBe("gen-1");    // id
    expect(values[0]).toBe("");         // Week untouched

    expect(plan.dbUpdates).toHaveLength(1);
    expect(plan.dbUpdates[0]).toMatchObject({
      id: "db1",
      patch: {
        sheet_id: "gen-1",
        source_key: "sheet:gen-1",
        sync_base: { topic: "App idea", description: "body", asset_ref: "" },
      },
    });
    expect(plan.idBackfills).toHaveLength(0);
    expect(plan.counts).toMatchObject({ newSheetRows: 1, pushedToSheet: 1 });
  });

  it("sheet-only field edit → db update (pull), no sheet write", () => {
    const s = sheetRow({ id: "s1", topic: "T", description: "new", asset_ref: "" });
    const db = dbRow({
      id: "db1",
      sheet_id: "s1",
      source_key: "sheet:s1",
      topic: "T",
      description: "old",
      asset_ref: null,
      sync_base: { topic: "T", description: "old", asset_ref: "" },
    });
    const plan = planSync([s], [db], opts());

    expect(plan.sheetCellUpdates).toHaveLength(0);
    expect(plan.dbUpdates).toHaveLength(1);
    expect(plan.dbUpdates[0]).toMatchObject({
      id: "db1",
      patch: { description: "new", sync_base: { topic: "T", description: "new", asset_ref: "" } },
    });
    expect(plan.counts).toMatchObject({ updatedInApp: 1, pulledFromSheet: 1, conflicts: 0, updatedInSheet: 0 });
  });

  it("app-only field edit → sheet cell update (push), no field pulled to db", () => {
    const s = sheetRow({ id: "s1", topic: "T", description: "base", asset_ref: "" });
    const db = dbRow({
      id: "db1",
      sheet_id: "s1",
      source_key: "sheet:s1",
      topic: "T",
      description: "appEdited",
      asset_ref: null,
      sync_base: { topic: "T", description: "base", asset_ref: "" },
    });
    const plan = planSync([s], [db], opts());

    expect(plan.sheetCellUpdates).toEqual([{ address: "E5", value: "appEdited" }]);
    expect(plan.dbUpdates).toHaveLength(1);
    // No `description` field pulled into the db (app value already there); only the base moves.
    expect(plan.dbUpdates[0]!.patch).toEqual({
      sync_base: { topic: "T", description: "appEdited", asset_ref: "" },
    });
    expect(plan.counts).toMatchObject({ updatedInSheet: 1, pushedToSheet: 1, updatedInApp: 0, conflicts: 0 });
  });

  it("conflict (both edited since base) → app wins + conflict counted", () => {
    const s = sheetRow({ id: "s1", topic: "T", description: "sheetVal", asset_ref: "" });
    const db = dbRow({
      id: "db1",
      sheet_id: "s1",
      source_key: "sheet:s1",
      topic: "T",
      description: "appVal",
      asset_ref: null,
      sync_base: { topic: "T", description: "base", asset_ref: "" },
    });
    const plan = planSync([s], [db], opts());

    // App value overwrites the sheet cell.
    expect(plan.sheetCellUpdates).toEqual([{ address: "E5", value: "appVal" }]);
    expect(plan.dbUpdates[0]!.patch).toEqual({
      sync_base: { topic: "T", description: "appVal", asset_ref: "" },
    });
    expect(plan.counts).toMatchObject({ conflicts: 1, updatedInSheet: 1, pushedToSheet: 1, updatedInApp: 0 });
  });

  it("legacy row adopted by hash → linked, not duplicated", () => {
    const s = sheetRow({ id: "", topic: "Legacy Topic", description: "sheetDesc", asset_ref: "" });
    const db = dbRow({
      id: "db9",
      sheet_id: null,
      source_key: legacySourceKey("Legacy Topic"),
      topic: "Legacy Topic",
      description: "dbDesc",
      asset_ref: null,
      sync_base: null,
    });
    const plan = planSync([s], [db], opts());

    expect(plan.dbInserts).toHaveLength(0); // no duplicate
    expect(plan.idBackfills).toEqual([{ address: "H5", value: "gen-1" }]);
    expect(plan.dbUpdates).toHaveLength(1);
    expect(plan.dbUpdates[0]).toMatchObject({
      id: "db9",
      patch: {
        sheet_id: "gen-1",
        source_key: "sheet:gen-1",
        sync_base: { topic: "Legacy Topic", description: "dbDesc", asset_ref: "" },
      },
    });
    expect(plan.counts).toMatchObject({ newAppRows: 0, idsBackfilled: 1 });
  });

  it("unchanged matched row → no actions", () => {
    const s = sheetRow({ id: "s1", topic: "T", description: "d", asset_ref: "a" });
    const db = dbRow({
      id: "db1",
      sheet_id: "s1",
      source_key: "sheet:s1",
      topic: "T",
      description: "d",
      asset_ref: "a",
      sync_base: { topic: "T", description: "d", asset_ref: "a" },
    });
    const plan = planSync([s], [db], opts());

    expect(plan.sheetCellUpdates).toHaveLength(0);
    expect(plan.dbUpdates).toHaveLength(0);
    expect(plan.dbInserts).toHaveLength(0);
    expect(plan.idBackfills).toHaveLength(0);
    expect(plan.sheetRowAdds).toHaveLength(0);
    expect(plan.counts).toMatchObject({
      pulledFromSheet: 0,
      pushedToSheet: 0,
      updatedInApp: 0,
      updatedInSheet: 0,
      conflicts: 0,
      newAppRows: 0,
      newSheetRows: 0,
    });
  });

  it("row removed from sheet (db linked, no sheet match) → no delete, no action", () => {
    const db = dbRow({
      id: "db5",
      sheet_id: "gone",
      source_key: "sheet:gone",
      topic: "T",
      description: "d",
      asset_ref: null,
      sync_base: { topic: "T", description: "d", asset_ref: "" },
    });
    const plan = planSync([], [db], opts());

    expect(plan.dbUpdates).toHaveLength(0);
    expect(plan.dbInserts).toHaveLength(0);
    expect(plan.sheetRowAdds).toHaveLength(0);
    expect(plan.sheetCellUpdates).toHaveLength(0);
    expect(plan.counts).toMatchObject({ newSheetRows: 0, newAppRows: 0 });
  });

  it("blank spacer rows (empty topic and id) are ignored", () => {
    const spacer = sheetRow({ id: "", topic: "" });
    const plan = planSync([spacer], [], opts());
    expect(plan.dbInserts).toHaveLength(0);
    expect(plan.idBackfills).toHaveLength(0);
    expect(plan.plan).toHaveLength(0);
  });
});
