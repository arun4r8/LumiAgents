/**
 * Microsoft Graph workbook (Excel) helpers.
 *
 * Reads a worksheet's used range as a raw string grid, plus Excel Table helpers
 * (read/patch/append) used by the two-way content-calendar sync
 * (orchestrations/cleo/content-sync).
 */

import { graphGet, graphPatch, graphPost, graphBatch, type MsGraphEnv } from "./base";

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

/**
 * List the workbooks in a drive folder, addressed by PATH.
 *
 * BD's GovWin exports are addressed this way because they cannot be addressed any
 * other way. There are three of them in one folder and two carry the export DATE in
 * the filename ("Upcoming Deals opportunitySearchResults_07-28-2026.xlsx"), so both
 * the driveItem id and the exact filename change every time someone re-exports.
 * The FOLDER is the only stable handle, so the importer takes what is in it.
 *
 * Graph's path addressing is `/drives/{id}/root:/a/b:/children`. The segments are
 * encoded individually -- encoding the whole path would escape the separators --
 * and a leading slash would produce an empty first segment, so it is stripped. An
 * empty path means the drive root, which Graph spells `/root/children` with no
 * colons at all.
 *
 * A 404 returns [] : "the folder is not there" is a normal answer to "what is in
 * the folder", and it must not read the same as a permission failure, which throws.
 */
export async function listWorkbooksInFolder(
  env: MsGraphEnv,
  opts: { driveId: string; folderPath: string },
): Promise<Array<{ id: string; name: string; webUrl: string | null; lastModified: string | null }>> {
  const segments = opts.folderPath.split("/").filter((s) => s.length > 0);
  const encoded = segments.map((s) => encodeURIComponent(s)).join("/");
  const path =
    segments.length === 0
      ? `/drives/${opts.driveId}/root/children`
      : `/drives/${opts.driveId}/root:/${encoded}:/children`;

  let res: { value?: Array<{ id?: string; name?: string; webUrl?: string; lastModifiedDateTime?: string; folder?: unknown }> };
  try {
    res = await graphGet(env, `${path}?$select=id,name,webUrl,lastModifiedDateTime,folder&$top=200`);
  } catch (e) {
    // callJson throws `<label> → <status>: <body>`, so match the status the way it
    // is actually formatted -- a bare /404/ would also match a 404 mentioned in the
    // error body of some other failure.
    if (/→ 404:/.test(String(e))) return [];
    throw e;
  }

  return (res.value ?? [])
    // `folder` is present only on folders. Excluding them here means a subfolder
    // named something.xlsx cannot be handed to the workbook API as a workbook.
    .filter((c) => c.folder === undefined && typeof c.name === "string" && /\.xlsx$/i.test(c.name) && c.id)
    // Excel's own lock files. They are real driveItems with a real .xlsx extension
    // and they are not workbooks.
    .filter((c) => !c.name!.startsWith("~$"))
    .map((c) => ({
      id: c.id!,
      name: c.name!,
      webUrl: c.webUrl ?? null,
      lastModified: c.lastModifiedDateTime ?? null,
    }));
}

// ─── Excel Table helpers (two-way sync) ────────────────────────────────────────

/**
 * 0-based column index → spreadsheet column letters. 0→A, 25→Z, 26→AA, 27→AB…
 */
export function colLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// Parse a Graph range address like "Sheet1!A1:H31" into its sheet name and the
// top-left anchor (0-based column index, 1-based row). Sheet names may be quoted
// ("'My Sheet'!A1:..."), so strip surrounding single quotes and unescape doubled
// single quotes.
function parseAddress(address: string): { sheetName: string; topCol: number; topRow: number } {
  const bang = address.lastIndexOf("!");
  let sheetName = bang >= 0 ? address.slice(0, bang) : "";
  const range = bang >= 0 ? address.slice(bang + 1) : address;
  if (sheetName.startsWith("'") && sheetName.endsWith("'")) {
    sheetName = sheetName.slice(1, -1).replace(/''/g, "'");
  }
  const topLeft = (range.split(":")[0] ?? range).trim();
  const m = topLeft.match(/^([A-Za-z]+)(\d+)$/);
  let topCol = 0;
  let topRow = 1;
  if (m) {
    const letters = m[1]!.toUpperCase();
    let col = 0;
    for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
    topCol = col - 1;
    topRow = Number(m[2]);
  }
  return { sheetName, topCol, topRow };
}

export interface TableRead {
  sheetName: string;
  topRow: number; // 1-based row of the header (table range top)
  topCol: number; // 0-based column of the table's leftmost column
  headers: string[];
  rows: string[][]; // data rows only (header excluded), cells coerced to string
}

/**
 * Read an Excel Table's full range (headers + data) via the workbook API. Returns
 * the parsed anchor (sheet name / top row / top col from the range address) plus the
 * header row and the data rows as a string grid.
 */
export async function readTable(
  env: MsGraphEnv,
  opts: { driveId: string; itemId: string; table: string },
): Promise<TableRead> {
  const { driveId, itemId, table } = opts;
  const path =
    `/drives/${driveId}/items/${itemId}/workbook/tables('${encodeURIComponent(table)}')` +
    `/range?$select=address,values`;
  const res = await graphGet<{ address?: string; values?: unknown[][] }>(env, path);

  const address = res.address ?? "";
  const { sheetName, topCol, topRow } = parseAddress(address);

  const values = Array.isArray(res.values) ? res.values : [];
  const grid = values.map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => (cell == null ? "" : String(cell))),
  );
  const headers = grid[0] ?? [];
  const rows = grid.slice(1);
  return { sheetName, topRow, topCol, headers, rows };
}

/**
 * Write a single cell (or 1x1 range) on a worksheet. `address` is a column+row like
 * "E5". Uses the worksheet range endpoint so we can target absolute cells regardless
 * of the table's own row indexing.
 */
export async function updateCell(
  env: MsGraphEnv,
  opts: { driveId: string; itemId: string; sheetName: string; address: string; value: string },
): Promise<void> {
  const { driveId, itemId, sheetName, address, value } = opts;
  const path =
    `/drives/${driveId}/items/${itemId}/workbook/worksheets('${encodeURIComponent(sheetName)}')` +
    `/range(address='${encodeURIComponent(address)}')`;
  await graphPatch<unknown>(env, path, { values: [[value]] });
}

/**
 * Append a row to an Excel Table. `values` is one full row in header order. Graph
 * inserts it at the bottom of the table.
 */
export async function addTableRow(
  env: MsGraphEnv,
  opts: { driveId: string; itemId: string; table: string; values: string[] },
): Promise<void> {
  await addTableRows(env, { ...opts, rows: [opts.values] });
}

/**
 * Append several rows to an Excel Table in ONE Graph call.
 *
 * The rows endpoint already takes an array of rows -- the single-row version was
 * simply passing an array of one. Appending 40 rows was therefore 40 subrequests
 * where 1 would do, against a 50-per-invocation Worker ceiling.
 */
export async function addTableRows(
  env: MsGraphEnv,
  opts: { driveId: string; itemId: string; table: string; rows: string[][] },
): Promise<void> {
  if (opts.rows.length === 0) return;
  const { driveId, itemId, table, rows } = opts;
  const path =
    `/drives/${driveId}/items/${itemId}/workbook/tables('${encodeURIComponent(table)}')/rows`;
  await graphPost<unknown>(env, path, { values: rows });
}

/**
 * Update many individual cells using Graph's JSON batch endpoint.
 *
 * Cell addresses in a sync are scattered (one per changed field), so they cannot be
 * collapsed into a single range write. Batching is the next best thing: 20 per
 * request instead of one each.
 */
export async function updateCells(
  env: MsGraphEnv,
  opts: { driveId: string; itemId: string; sheetName: string; updates: { address: string; value: string }[] },
): Promise<void> {
  if (opts.updates.length === 0) return;
  const { driveId, itemId, sheetName, updates } = opts;
  await graphBatch(
    env,
    updates.map((u, i) => ({
      id: String(i),
      method: "PATCH" as const,
      // Batch request URLs are relative to /v1.0 and must not be absolute.
      url:
        `/drives/${driveId}/items/${itemId}/workbook/worksheets('${encodeURIComponent(sheetName)}')` +
        `/range(address='${encodeURIComponent(u.address)}')`,
      body: { values: [[u.value]] },
    })),
  );
}
