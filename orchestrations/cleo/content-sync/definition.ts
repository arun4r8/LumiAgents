import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";
import { readTable, updateCells, addTableRows, colLetter } from "../../../integrations/msgraph/workbook";
import { planSync, dbUpsertRows, type DbRow, type SheetRow, type SheetLayout } from "./merge";

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

/**
 * Most content_calendar rows this sync will read in one go.
 *
 * The read returns its rows as a Workflow step value, and Cloudflare caps a step
 * return at 1 MiB. These rows carry free text and a sync_base blob, so the byte
 * limit binds well before any sensible row count. Exceeding this raises rather than
 * truncating: a half-read calendar syncs as "these rows were deleted from the app".
 */
const MAX_CALENDAR_ROWS = 2000;

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
  linked: z.number().default(0).describe("Existing app rows linked to a sheet row (adoptions). A run that only links reports zero everywhere else."),
  conflicts: z.number(),
  newSheetRows: z.number(),
  newAppRows: z.number(),
  skipped: z.number(),
  // A SAMPLE, capped at PLAN_PREVIEW_LIMIT. Read planTotal for the real number --
  // this list used to be silently sliced to 100, so a dry run against a 400-row
  // sheet promised 100 actions and the real run issued 400.
  plan: z.array(planEntrySchema).optional().describe("Sample of the planned actions, at most PLAN_PREVIEW_LIMIT entries."),
  planTotal: z.number().optional().describe("How many actions the real run would take. Always the full count."),
  planTruncated: z.boolean().optional().describe("True when `plan` is a sample rather than the whole list."),
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
      // Bounded, and it FAILS at the bound rather than silently syncing a subset.
      //
      // This used to read limit=10000 and return the rows as a step value. A
      // Cloudflare Workflow step return is capped at 1 MiB, and these rows carry
      // topic, description, asset_ref and a sync_base blob -- a few thousand of them
      // exceed that long before the row cap does, and the failure would arrive as a
      // step error with nothing pointing at size.
      //
      // A content calendar is a planning sheet. If it ever holds more rows than this,
      // the right answer is paging with a cursor, not a bigger number -- so this
      // stops and says so instead of quietly dropping the tail.
      const res = await ctx.fetch(
        `${env.SUPABASE_URL}/rest/v1/content_calendar?select=id,sheet_id,source_key,topic,description,asset_ref,sync_base&limit=${MAX_CALENDAR_ROWS + 1}`,
        { headers: sbHeaders(env) },
      );
      if (!res.ok) throw new Error(`content_calendar read → ${res.status}: ${await res.text()}`);
      const rows = (await res.json()) as DbRow[];
      if (rows.length > MAX_CALENDAR_ROWS) {
        throw new Error(
          `content_calendar has more than ${MAX_CALENDAR_ROWS} rows. This sync reads them all into one ` +
            `Workflow step, whose return value Cloudflare caps at 1 MiB. Page this read before raising the cap.`,
        );
      }
      return rows;
    });

    // ── Step 3: plan (pure). Generate ids here so they're memoized across replays. ─
    const plan = await step(ctx, "plan", async () =>
      planSync(read.sheetRows, dbRows, { layout: read.layout, genId: () => crypto.randomUUID() }),
    );

    // ── Step 4: apply (skipped entirely on a dry run) ─────────────────────────────
    if (!dryRun) {
      // Cell writes go through Graph's $batch (20 per request) rather than one call
      // each. On a first sync against the legacy sheet every row needs an id
      // backfill, so this was one subrequest per row -- two, before the token cache
      // -- against a 50-per-invocation Worker ceiling.
      await step(ctx, "backfill-ids", async () => {
        await updateCells(env, { driveId, itemId, sheetName: read.sheetName, updates: plan.idBackfills });
        return plan.idBackfills.length;
      });

      await step(ctx, "write-sheet-cells", async () => {
        await updateCells(env, { driveId, itemId, sheetName: read.sheetName, updates: plan.sheetCellUpdates });
        return plan.sheetCellUpdates.length;
      });

      // The rows endpoint always took an array; the single-row helper was passing an
      // array of one. All appends are now a single call.
      await step(ctx, "add-sheet-rows", async () => {
        await addTableRows(env, { driveId, itemId, table, rows: plan.sheetRowAdds.map((r) => r.values) });
        return plan.sheetRowAdds.length;
      });

      // Two requests total rather than one per row. PostgREST takes an array on
      // POST, and an upsert on the primary key expresses "update these rows, each
      // with its own patch" in a single call -- which a PATCH cannot, because each
      // row's patch differs.
      await step(ctx, "write-db", async () => {
        if (plan.dbInserts.length > 0) {
          const res = await ctx.fetch(`${env.SUPABASE_URL}/rest/v1/content_calendar`, {
            method: "POST",
            headers: sbHeaders(env, { extra: { Prefer: "return=minimal" } }),
            body: JSON.stringify(plan.dbInserts.map((i) => i.row)),
          });
          if (!res.ok) throw new Error(`content_calendar insert x${plan.dbInserts.length} → ${res.status}: ${await res.text()}`);
        }

        if (plan.dbUpdates.length > 0) {
          const now = new Date().toISOString();
          const res = await ctx.fetch(
            `${env.SUPABASE_URL}/rest/v1/content_calendar?on_conflict=id`,
            {
              method: "POST",
              headers: sbHeaders(env, {
                extra: { Prefer: "resolution=merge-duplicates,return=minimal" },
              }),
              // Each row carries its topic: see dbUpsertRows for why a bare patch fails.
              body: JSON.stringify(dbUpsertRows(plan.dbUpdates, dbRows, now)),
            },
          );
          if (!res.ok) throw new Error(`content_calendar update x${plan.dbUpdates.length} → ${res.status}: ${await res.text()}`);
        }

        return plan.dbInserts.length + plan.dbUpdates.length;
      });
    }

    return {
      dryRun,
      ...plan.counts,
      // planTotal travels with the sample ALWAYS, so a dry run can never be read as
      // "there are 100 actions" when there are 400. The counts above are already the
      // true totals; this makes the list agree with them.
      ...(dryRun
        ? { plan: plan.plan, planTotal: plan.planTotal, planTruncated: plan.planTruncated }
        : {}),
    };
  },
});
