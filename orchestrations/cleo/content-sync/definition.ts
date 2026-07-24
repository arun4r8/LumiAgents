import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";
import { readWorksheetGrid } from "../../../integrations/msgraph/workbook";
import { mapGridToRows } from "./map";

// Live-sync the content calendar from the team's planning spreadsheet in
// Microsoft 365 (Excel workbook on SharePoint/OneDrive) via the Graph workbook
// API, replacing the manual CSV export/import. Idempotent via `source_key`:
// re-running updates rows instead of duplicating, and produces the *same* keys
// as a CSV import of the same sheet (see map.ts), so the two paths interoperate.
// Only the mapped columns are written, so existing draft_markdown/status on a row
// are preserved (they're not in the upsert payload) — exactly like importCsv.

export const inputSchema = z.object({
  driveId: z.string().optional().describe("Graph drive ID hosting the workbook (default: CONTENT_CALENDAR_DRIVE_ID)."),
  itemId: z.string().optional().describe("Graph item ID of the workbook (default: CONTENT_CALENDAR_ITEM_ID)."),
  worksheet: z.string().optional().describe("Worksheet name (default: CONTENT_CALENDAR_WORKSHEET, else the first sheet)."),
});

export const outputSchema = z.object({
  synced: z.number(),
  skipped: z.number(),
});

export default defineOrchestration({
  name: "cleo/content-sync",
  version: 1,
  description:
    "Live-sync the content calendar from the team's Microsoft 365 planning workbook via the Graph API (idempotent on source_key; preserves drafts/status).",
  inputSchema,
  outputSchema,
  access: { triggerableBy: ["role:ops"], visibleTo: ["role:ops"] },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const env = ctx.env;

    const driveId = input.driveId ?? env.CONTENT_CALENDAR_DRIVE_ID;
    const itemId = input.itemId ?? env.CONTENT_CALENDAR_ITEM_ID;
    const worksheet = input.worksheet ?? env.CONTENT_CALENDAR_WORKSHEET;

    if (!driveId || !itemId || !env.MSGRAPH_TENANT_ID || !env.MSGRAPH_CLIENT_ID || !env.MSGRAPH_CLIENT_SECRET) {
      throw new Error(
        "Microsoft Graph content sync not configured (set MSGRAPH_* + CONTENT_CALENDAR_*)",
      );
    }

    // Step 1: read the worksheet's used range as a raw string grid.
    const grid = await step(ctx, "read-worksheet", async () =>
      readWorksheetGrid(env, {
        driveId,
        itemId,
        ...(worksheet ? { worksheet } : {}),
      }),
    );

    // Step 2: map the grid to content_calendar rows (byte-identical source_key to CSV import).
    const { rows, skipped } = mapGridToRows(grid, new Date().getFullYear());

    // Step 3: upsert on source_key. return=minimal + merge-duplicates; only the
    // mapped columns are sent, so drafts/status on existing rows are untouched.
    const synced = await step(ctx, "upsert", async () => {
      if (rows.length === 0) return 0;
      const res = await ctx.fetch(`${env.SUPABASE_URL}/rest/v1/content_calendar?on_conflict=source_key`, {
        method: "POST",
        headers: sbHeaders(env, { extra: { Prefer: "resolution=merge-duplicates,return=minimal" } }),
        body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`content_calendar upsert → ${res.status}: ${await res.text()}`);
      return rows.length;
    });

    return { synced, skipped };
  },
});
