/**
 * Microsoft Graph workbook (Excel) helpers.
 *
 * Reads a worksheet's used range as a raw string grid, so the same
 * header-matching / row-mapping used for CSV import can be reused for the live
 * Graph sync (see orchestrations/cleo/content-sync/map.ts).
 */

import { graphGet, type MsGraphEnv } from "./base";

interface WorksheetList {
  value?: Array<{ name?: string; position?: number }>;
}

interface UsedRange {
  values?: unknown[][];
}

/**
 * Read a worksheet's used range from a workbook stored in a drive.
 *
 * `worksheet` selects the sheet by name; when unset the sheet at position 0 is
 * used. Returns the used range's cells coerced to a `string[][]` grid (header
 * row first). An empty/blank sheet yields `[]`.
 */
export async function readWorksheetGrid(
  env: MsGraphEnv,
  opts: { driveId: string; itemId: string; worksheet?: string },
): Promise<string[][]> {
  const { driveId, itemId } = opts;
  const base = `/drives/${driveId}/items/${itemId}/workbook/worksheets`;

  let name = opts.worksheet;
  if (!name) {
    const sheets = await graphGet<WorksheetList>(env, `${base}?$select=name,position`);
    const first = (sheets.value ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
    if (!first?.name) return [];
    name = first.name;
  }

  const used = await graphGet<UsedRange>(
    env,
    `${base}('${encodeURIComponent(name)}')/usedRange(valuesOnly=true)?$select=values`,
  );

  const values = used.values;
  if (!Array.isArray(values) || values.length === 0) return [];
  return values.map((row) =>
    (Array.isArray(row) ? row : []).map((cell) =>
      cell == null ? "" : String(cell),
    ),
  );
}
