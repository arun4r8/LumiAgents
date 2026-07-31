import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";
import { readTable, updateCell, addTableRow, colLetter } from "../../../integrations/msgraph/workbook";
import { planSync, type DbRow, type SheetRow, type SheetLayout } from "./merge";

// Two-way content-calendar sync between public.content_calendar and the Microsoft
// 365 Excel Table `ContentCalendar`. Replaces the one-way v1 (which only pulled the
// sheet into the app). Now edits flow BOTH ways for the three shared fields
// (Topic ↔ topic, Caption Summary ↔ description, Graphic Recommendation ↔ asset_ref),
// reconciled with a 3-way merge against a per-row `sync_base` snapshot; on a genuine
// conflict (both sides edited since the last sync) the APP wins.
//
// Everything else is authoritative on exactly one side and never crossed: Week, Date,
// Content Pillar and Status on the sheet are never written here; release_date,
// channel, asset_type, status, draft_markdown and owner in the app are never touched
// by a sheet read. Legacy one-way rows are adopted by their old `csv:` source_key so
// re-running doesn't duplicate them. Deletions are never propagated in either
// direction. `dryRun` computes and returns the plan without performing any write.

export const inputSchema = z.object({
  driveId: z.string().optional().describe("Graph drive ID hosting the workbook (default: CONTENT_CALENDAR_DRIVE_ID)."),
  itemId: z.string().optional().describe("Graph item ID of the workbook (default: CONTENT_CALENDAR_ITEM_ID)."),
  dryRun: z.boolean().optional().describe("Compute the reconciliation plan and counts without writing to the sheet or the database."),
});

const planEntrySchema = z.object({
  action: z.string(),
  sheetId: z.string(),
  topic: z.string(),
  fields: z.array(z.string()).optional(),
});

export const outputSchema = z.object({
  dryRun: z.boolean(),
  pulledFromSheet: z.number(),
  pushedToSheet: z.number(),
  updatedInApp: z.number(),
  updatedInSheet: z.number(),
  idsBackfilled: z.number(),
  conflicts: z.number(),
  newSheetRows: z.number(),
  newAppRows: z.number(),
  skipped: z.number(),
  plan: z.array(planEntrySchema).optional(),
});

// Header → column matcher (same flexible, case-insensitive style the one-way CSV
// import used).
function matchHeader(headers: string[], patterns: RegExp[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!.toLowerCase().trim();
    if (patterns.some((p) => p.test(h))) return i;
  }
  return -1;
}

export default defineOrchestration({
  name: "cleo/content-sync",
  version: 2,
  description:
    "Two-way sync of the content calendar between the app and the Microsoft 365 Excel table (3-way merge on Topic/Caption/Graphic; app wins conflicts; adopts legacy rows; never deletes).",
  inputSchema,
  outputSchema,
  access: { triggerableBy: ["role:ops"], visibleTo: ["role:ops"] },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const env = ctx.env;

    const driveId = input.driveId ?? env.CONTENT_CALENDAR_DRIVE_ID;
    const itemId = input.itemId ?? env.CONTENT_CALENDAR_ITEM_ID;
    const table = env.CONTENT_CALENDAR_TABLE ?? "ContentCalendar";
    const dryRun = input.dryRun ?? false;

    if (!driveId || !itemId || !env.MSGRAPH_TENANT_ID || !env.MSGRAPH_CLIENT_ID || !env.MSGRAPH_CLIENT_SECRET) {
      throw new Error(
        "Microsoft Graph content sync not configured (set MSGRAPH_* + CONTENT_CALENDAR_*)",
      );
    }

    // ── Step 1: read the Excel table (headers + data), locate the mapped columns ──
    const read = await step(ctx, "read-table", async () => {
      const t = await readTable(env, { driveId, itemId, table });
      const idCol = matchHeader(t.headers, [/^id$/]);
      const topicCol = matchHeader(t.headers, [/topic/, /title/]);
      const descCol = matchHeader(t.headers, [/caption/, /description/, /brief/]);
      const graphicCol = matchHeader(t.headers, [/graphic/, /asset/, /image/]);

      const missing: string[] = [];
      if (idCol < 0) missing.push("id");
      if (topicCol < 0) missing.push("Topic");
      if (descCol < 0) missing.push("Caption Summary");
      if (graphicCol < 0) missing.push("Graphic Recommendation");
      if (missing.length) {
        throw new Error(`ContentCalendar table missing required column(s): ${missing.join(", ")}`);
      }

      const get = (r: string[], i: number) => (i >= 0 && r[i] != null ? r[i]!.trim() : "");
      const sheetRows: SheetRow[] = [];
      t.rows.forEach((r, rowIndex) => {
        const idv = get(r, idCol);
        const topic = get(r, topicCol);
        if (!topic && !idv) return; // blank spacer row → ignore
        sheetRows.push({
          rowIndex,
          sheetRow: t.topRow + 1 + rowIndex, // header at topRow; first data row at topRow+1
          id: idv,
          topic,
          description: get(r, descCol),
          asset_ref: get(r, graphicCol),
        });
      });

      const layout: SheetLayout = {
        colLetters: {
          id: colLetter(t.topCol + idCol),
          topic: colLetter(t.topCol + topicCol),
          description: colLetter(t.topCol + descCol),
          asset_ref: colLetter(t.topCol + graphicCol),
        },
        headerLen: t.headers.length,
        headerIndex: { id: idCol, topic: topicCol, description: descCol, asset_ref: graphicCol },
      };

      return { sheetName: t.sheetName, sheetRows, layout };
    });

    // ── Step 2: read all content_calendar rows ────────────────────────────────────
    const dbRows = await step(ctx, "read-db", async () => {
      const res = await ctx.fetch(
        `${env.SUPABASE_URL}/rest/v1/content_calendar?select=id,sheet_id,source_key,topic,description,asset_ref,sync_base&limit=10000`,
        { headers: sbHeaders(env) },
      );
      if (!res.ok) throw new Error(`content_calendar read → ${res.status}: ${await res.text()}`);
      return (await res.json()) as DbRow[];
    });

    // ── Step 3: plan (pure). Generate ids here so they're memoized across replays. ─
    const plan = await step(ctx, "plan", async () =>
      planSync(read.sheetRows, dbRows, { layout: read.layout, genId: () => crypto.randomUUID() }),
    );

    // ── Step 4: apply (skipped entirely on a dry run) ─────────────────────────────
    if (!dryRun) {
      await step(ctx, "backfill-ids", async () => {
        for (const u of plan.idBackfills) {
          await updateCell(env, { driveId, itemId, sheetName: read.sheetName, address: u.address, value: u.value });
        }
        return plan.idBackfills.length;
      });

      await step(ctx, "write-sheet-cells", async () => {
        for (const u of plan.sheetCellUpdates) {
          await updateCell(env, { driveId, itemId, sheetName: read.sheetName, address: u.address, value: u.value });
        }
        return plan.sheetCellUpdates.length;
      });

      await step(ctx, "add-sheet-rows", async () => {
        for (const r of plan.sheetRowAdds) {
          await addTableRow(env, { driveId, itemId, table, values: r.values });
        }
        return plan.sheetRowAdds.length;
      });

      await step(ctx, "write-db", async () => {
        for (const ins of plan.dbInserts) {
          const res = await ctx.fetch(`${env.SUPABASE_URL}/rest/v1/content_calendar`, {
            method: "POST",
            headers: sbHeaders(env, { extra: { Prefer: "return=minimal" } }),
            body: JSON.stringify(ins.row),
          });
          if (!res.ok) throw new Error(`content_calendar insert → ${res.status}: ${await res.text()}`);
        }
        const now = new Date().toISOString();
        for (const upd of plan.dbUpdates) {
          const res = await ctx.fetch(
            `${env.SUPABASE_URL}/rest/v1/content_calendar?id=eq.${upd.id}`,
            {
              method: "PATCH",
              headers: sbHeaders(env, { extra: { Prefer: "return=minimal" } }),
              body: JSON.stringify({ ...upd.patch, updated_at: now }),
            },
          );
          if (!res.ok) throw new Error(`content_calendar update ${upd.id} → ${res.status}: ${await res.text()}`);
        }
        return plan.dbInserts.length + plan.dbUpdates.length;
      });
    }

    return {
      dryRun,
      ...plan.counts,
      ...(dryRun ? { plan: plan.plan } : {}),
    };
  },
});
