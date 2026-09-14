import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";
import { fnv1a } from "@/runtime/utils/hash";
import { loadContentHashLedger, contentChanged, upsertContentHashLedger } from "@/runtime/utils/scored-sweep";
import { readWorksheetGrid, listWorkbooksInFolder } from "../../../integrations/msgraph/workbook";
import {
  indexHeaders,
  mapRow,
  selectForScoring,
  type GovWinRow,
} from "../../../integrations/govwin/import";
import {
  recommendationFor,
  SCORE_BATCH_SIZE,
  SCORE_MAX_TOKENS,
  SCORE_TIMEOUT_MS,
} from "../opportunity-sweep/definition";

/**
 * Import BD's GovWin IQ export into the same pipeline as the SAM.gov sweep (#198).
 *
 * The sweep can only see what is posted to SAM.gov. The pursuit BD is running right
 * now is GSA eBuy RFQ1835138 (Advana / Army Vantage), which is visible only to
 * schedule holders on the eBuy portal and appears on SAM never. The most important
 * opportunity in the business was invisible to the system built to find
 * opportunities, and no amount of tuning the sweep would have found it.
 *
 * BD already keeps a GovWin export in SharePoint and works from it by hand, so this
 * does not ask anyone to change what they do: it reads the file they already
 * maintain. What it adds is the scoring, the deduplication and the board -- and
 * three fields SAM does not publish at all: a contract value, a named incumbent,
 * and a written summary.
 *
 * Deliberately NOT a second sweep:
 *   - It shares the ledger (orchestration.scored_notices), so a row that has already
 *     been scored is not re-billed on every weekly run, and an amended row is.
 *   - It shares `recommendationFor`, the score scale, and the Lumiture profile, so a
 *     GovWin 7 means what a SAM 7 means. Two scales on one board would be worse
 *     than no score at all.
 *   - It writes the same table with the same conflict key. `sam_notice_id` is the
 *     generic external id despite the name (SBIR already stores `sbir_<topic>`
 *     there); GovWin rows store `govwin_<Opp ID>`.
 */

/**
 * Where the exports live: a folder in the Lumiture Labs library, beside the
 * per-pursuit folders BD already keeps under Opportunity Tracking.
 *
 * They started on the BD site, which the app's Sites.Selected grant does not
 * cover (#244). Moving them here needed no new permission at all -- this library
 * is already granted, for beady/project-folder -- which beats widening access to
 * a second site for a read-only job.
 *
 * A FOLDER, not a file. There are three exports -- VA.xlsx, "State Local
 * opportunitySearchResults_07-28-2026.xlsx" and "Upcoming Deals
 * opportunitySearchResults_07-28-2026.xlsx" -- and two of those names carry the
 * export date, so any fixed filename is wrong the next time someone re-exports.
 * The folder is the only part a person keeps stable, so that is what is configured.
 */
const DEFAULT_FOLDER = "Opportunity Tracking/GovWin";

// Each scored row carries a summary, so its prompt share is bigger than a SAM
// notice's. Scoring is still the same shape as the sweep: one llm_extract per batch
// at 3 subrequests each, which is why the cut happens BEFORE scoring, not after.
export const MAX_ROWS_TO_SCORE = 180;

/**
 * How many workbooks one run will open. Each costs 2 subrequests (the sheet list,
 * then the used range) against a ceiling of 50 for the whole run, and the folder is
 * a place people drop files: one careless upload of a year of exports should cost a
 * truncated run, not a dead one.
 */
export const MAX_WORKBOOKS = 5;

/**
 * Sheet grids -> the rows this run will actually score.
 *
 * Exported and pure because this is the WIRING, and the wiring is what went wrong
 * last time: #219 shipped a tested predicate and a tested schema joined by an
 * untested call, and the bug lived in the join. Header indexing, row mapping,
 * cross-workbook dedupe, the NAICS/horizon cut and the cap only mean something in
 * that order.
 *
 * Takes every workbook at once rather than one at a time, because the dedupe has to
 * happen ACROSS them: the same Opp ID appears in more than one export (a VA pursuit
 * is in both VA.xlsx and Upcoming Deals), and two rows with one external id in a
 * single upsert make Postgres throw "ON CONFLICT DO UPDATE command cannot affect
 * row a second time" -- which loses the whole batch, not the duplicate.
 */
export function rowsToScore(
  workbooks: Array<{ name: string; webUrl: string | null; grid: string[][] }>,
  opts: { naicsCodes: string[]; horizonMonths: number; now: Date },
): { mapped: ImportRow[]; selected: ImportRow[] } {
  const mapped: ImportRow[] = [];
  const seen = new Set<string>();

  for (const wb of workbooks) {
    if (wb.grid.length < 2) continue;
    const idx = indexHeaders(wb.grid[0]!);
    for (const raw of wb.grid.slice(1)) {
      const row = mapRow(raw, idx);
      if (!row) continue;
      // First workbook wins. Order is the folder listing's, which is stable, so a
      // re-run resolves a duplicate the same way twice.
      if (seen.has(row.externalId)) continue;
      seen.add(row.externalId);
      mapped.push({ ...row, sourceFile: wb.name, sourceUrl: wb.webUrl });
    }
  }

  // The cap is here rather than at the call site so it cannot be forgotten by a
  // second caller: it is the only thing standing between a 3,000-row export and
  // 50 scoring batches against a 50-subrequest ceiling.
  const selected = selectForScoring(mapped, opts).slice(0, MAX_ROWS_TO_SCORE) as ImportRow[];
  return { mapped, selected };
}

/** A mapped row plus which export it came from -- the only provenance there is. */
export interface ImportRow extends GovWinRow {
  sourceFile: string;
  sourceUrl: string | null;
}

function govwinContentHash(r: GovWinRow): string {
  // The fields a re-score would actually depend on. Deliberately not the whole row:
  // GovWin rewrites its own tracking columns constantly, and hashing those would
  // re-score the entire export every week.
  return fnv1a([r.title, r.status, r.naicsCode, r.summary, r.estimatedValueUsd, r.responseDeadline].join("|"));
}

export const inputSchema = z.object({
  driveId: z
    .string()
    .optional()
    .describe("Graph drive hosting the document library the exports live in (default: BD_DRIVE_ID, the Lumiture Labs library)."),
  folderPath: z
    .string()
    .default(DEFAULT_FOLDER)
    .describe("Folder holding the GovWin exports, within that drive. A folder, not a file: two of the three exports carry their export date in the filename."),
  worksheet: z
    .string()
    .optional()
    .describe("Worksheet name. Defaults to each workbook's first sheet, which is where GovWin's export puts its data (VA.xlsx calls its sheet 'VA Super Swath')."),
  naicsCodes: z
    .array(z.string())
    .default(["541512", "541511", "541519", "518210", "541611"])
    .describe("Rows outside these NAICS codes are dropped before scoring. A row with no NAICS at all is KEPT: early forecasts often have none."),
  horizonMonths: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(18)
    .describe("Drop rows soliciting further out than this. The export reaches years ahead; a 2029 pursuit is real but is not this quarter's work."),
  minScore: z.number().int().min(1).max(10).default(5).describe("Minimum fit score to keep a row."),
});

export const outputSchema = z.object({
  workbooks: z.array(z.string()).default([]).describe("The exports this run read, by filename."),
  rows: z.number().describe("Data rows across those exports."),
  mapped: z.number().describe("Of those, distinct rows with both an Opp ID and a Program Name -- the rest are spacers, footers, and the same pursuit appearing in two exports."),
  selected: z.number().describe("Rows inside the NAICS filter and the horizon."),
  scored: z.number().describe("Of those, the ones not already scored with unchanged content."),
  shortlisted: z.number().describe("Rows at or above minScore, upserted into opportunities."),
  scoreDistribution: z.record(z.number()).optional().describe("Count at each fit score 1-10, before the minScore cut -- the sub-floor scores exist nowhere else."),
  totalValueUsd: z.number().nullable().describe("Summed contract value of the shortlist, in dollars. The number SAM.gov has never been able to give us."),
  skipped: z.string().nullable().describe("Why nothing happened, when nothing happened."),
});

const scoreSchema = z.object({
  scored: z.array(
    z.object({
      id: z.string(),
      fitScore: z.number().int().min(1).max(10),
      fitReason: z.string().max(200),
      redFlags: z.string().max(200).nullable(),
    }),
  ),
});

export default defineOrchestration({
  name: "beady/govwin-import",
  version: 1,
  description:
    "Read BD's GovWin IQ export from SharePoint, score the near-term rows on the same scale as the SAM.gov sweep, and upsert the shortlist into opportunities.",
  // Monday 07:40, ahead of the sweep's 08:00, so a Monday board is complete.
  cron: "40 7 * * 1",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const empty = { workbooks: [] as string[], rows: 0, mapped: 0, selected: 0, scored: 0, shortlisted: 0, totalValueUsd: null };

    const driveId = input.driveId ?? ctx.env.BD_DRIVE_ID;
    if (!driveId || !ctx.env.MSGRAPH_TENANT_ID || !ctx.env.MSGRAPH_CLIENT_ID || !ctx.env.MSGRAPH_CLIENT_SECRET) {
      return { ...empty, skipped: "Microsoft Graph or BD_DRIVE_ID not configured" };
    }

    const files = await step(ctx, "list-exports", async () =>
      listWorkbooksInFolder(ctx.env, { driveId, folderPath: input.folderPath }),
    );
    if (files.length === 0) {
      // Not a crash: the folder may be empty, or Graph may not see it this minute.
      // A failed run on the board reads as a broken importer, which is worse than
      // an honest "nothing to import".
      return { ...empty, skipped: `No workbooks in "${input.folderPath}"` };
    }

    const opened = files.slice(0, MAX_WORKBOOKS);
    const workbooks = await step(ctx, "read-exports", async () => {
      const out: Array<{ name: string; webUrl: string | null; grid: string[][] }> = [];
      for (const f of opened) {
        const grid = await readWorksheetGrid(ctx.env, {
          driveId,
          itemId: f.id,
          // exactOptionalPropertyTypes: an absent worksheet and an explicit
          // undefined are different types here, and only the absent one means
          // "first sheet".
          ...(input.worksheet ? { worksheet: input.worksheet } : {}),
        });
        out.push({ name: f.name, webUrl: f.webUrl, grid });
      }
      return out;
    });

    const dataRows = workbooks.reduce((n, w) => n + Math.max(0, w.grid.length - 1), 0);

    const { mapped, selected } = rowsToScore(workbooks, {
      naicsCodes: input.naicsCodes,
      horizonMonths: input.horizonMonths,
      now: new Date(),
    });
    if (mapped.length === 0) {
      // Every sheet was empty, or none of them was a GovWin export: a workbook with
      // no "Opp ID" column maps every row to null. Say so rather than reporting a
      // clean run over nothing.
      return { ...empty, workbooks: opened.map((f) => f.name), rows: dataRows, skipped: `No GovWin rows in ${opened.length} workbook(s)` };
    }

    const externalId = (r: GovWinRow) => `govwin_${r.externalId}`;

    // Dedupe against everything ever scored, by content hash, so a weekly run on a
    // mostly-unchanged export costs one LLM call or none.
    const ledger = await loadContentHashLedger(ctx, {
      table: "scored_notices",
      keyColumn: "notice_id",
      profile: "orchestration",
      warnLabel: "[govwin] ledger load",
    });
    const toScore = selected.filter((r) => contentChanged(ledger, externalId(r), govwinContentHash(r)));

    if (toScore.length === 0) {
      // Nothing changed since the last run: the export is refreshed by hand, so
      // this is the expected outcome most weeks and costs no LLM call at all.
      return { ...empty, workbooks: opened.map((f) => f.name), rows: dataRows, mapped: mapped.length, selected: selected.length, skipped: null };
    }

    const batches: ImportRow[][] = [];
    for (let i = 0; i < toScore.length; i += SCORE_BATCH_SIZE) {
      batches.push(toScore.slice(i, i + SCORE_BATCH_SIZE));
    }

    const scoredRows: z.infer<typeof scoreSchema>["scored"] = [];
    for (const [i, batch] of batches.entries()) {
      const result = await llm_extract(ctx, {
        name: batches.length === 1 ? "score-govwin-rows" : `score-govwin-rows-${i + 1}-of-${batches.length}`,
        prompt: `
You are Beady, Lumiture's BD AI. Score each opportunity below against Lumiture's profile.

These come from GovWin IQ, a market-intelligence feed, not from SAM.gov. Many are
FORECASTS: the solicitation has not been issued yet, and the summary describes the
agency's intent rather than a set of requirements. That is the point of this source
-- it is the only pre-solicitation visibility we have -- so do NOT mark something
down merely for being early. Score the work described.

Lumiture profile:
- Core services: database management (PostgreSQL, Oracle, SQL Server, cloud DBs), data engineering,
  AI/ML integration, cloud infrastructure (AWS/Azure/GCP), analytics, software development
- Business type: small business, US-based, cleared staff available
- Sweet spot: data modernisation, AI/ML tooling, cloud migration, decision support systems,
  managed database services for federal agencies
- Lower fit: construction, physical hardware, manufacturing, chemical/biological R&D

Scoring (1-10):
- 8-10: strong direct match
- 6-7: partial match or promising with a partner
- 4-5: stretch, surface for leadership to decide
- 1-3: out of scope

Two fields here have no SAM.gov equivalent and are worth weighing. An INCUMBENT
means a recompete: note in redFlags when the incumbent is a large prime we would
have to unseat. A VALUE far outside what a small business can staff is a red flag
even when the technical fit is perfect.

Score EVERY row and return one entry for each, including the ones you score 1. Do
not filter, rank or omit anything: what to keep is decided downstream. Use the id
field exactly as given.

Keep fitReason to ONE SENTENCE of at most 25 words, and redFlags to a short clause
or null. These land on a card and in a digest row; length costs the reader nothing
and costs the batch a great deal.
        `.trim(),
        input: {
          opportunities: batch.map((r) => ({
            id: externalId(r),
            title: r.title,
            agency: [r.agency, r.subAgency].filter(Boolean).join(" / ") || null,
            naicsCode: r.naicsCode,
            competitionType: r.setAside,
            estimatedValueUsd: r.estimatedValueUsd,
            incumbent: r.incumbent,
            vehicle: r.vehicle,
            status: r.status,
            deadline: r.responseDeadline,
            summary: r.summary?.slice(0, 2_000) ?? null,
          })),
        },
        schema: scoreSchema,
        maxTokens: SCORE_MAX_TOKENS,
        timeoutMs: SCORE_TIMEOUT_MS,
      });
      scoredRows.push(...result.scored);
    }

    const scoreMap = new Map(scoredRows.map((s) => [s.id, s]));
    const scoredAt = new Date().toISOString();

    // Record every row scored, above the floor or below it. The sub-floor scores
    // exist nowhere else, and they are the only way to ask whether the floor is
    // set right (#206).
    await step(ctx, "record-scored-rows", async () => {
      await upsertContentHashLedger(ctx, {
        table: "scored_notices",
        conflictColumn: "notice_id",
        profile: "orchestration",
        rows: toScore.map((r) => {
          const s = scoreMap.get(externalId(r));
          return {
            notice_id: externalId(r),
            source: "govwin",
            fit_score: s?.fitScore ?? null,
            recommendation: s ? recommendationFor(s.fitScore) : "pass",
            content_hash: govwinContentHash(r),
            scored_at: scoredAt,
          };
        }),
        warnLabel: "[govwin] scored_notices insert",
      });
    });

    const scoreDistribution: Record<string, number> = {};
    for (const s of scoredRows) {
      scoreDistribution[String(s.fitScore)] = (scoreDistribution[String(s.fitScore)] ?? 0) + 1;
    }

    const shortlist = toScore
      .map((r) => ({ row: r, score: scoreMap.get(externalId(r)) }))
      .filter((x): x is { row: ImportRow; score: NonNullable<typeof x.score> } =>
        x.score !== undefined && x.score.fitScore >= input.minScore,
      );

    if (shortlist.length > 0) {
      await step(ctx, "upsert-opportunities", async () => {
        const rows = shortlist.map(({ row, score }) => ({
          sam_notice_id:       externalId(row),
          solicitation_number: row.solicitationNumber,
          title:               row.title,
          agency:              row.agency,
          naics_code:          row.naicsCode,
          set_aside:           row.setAside,
          response_deadline:   row.responseDeadline,
          source:              "govwin",
          // GovWin's web UI is licence-walled, so there is no per-row public URL
          // to link. The export it came from is the provenance, and it is a link a
          // person can actually open.
          source_url:          row.sourceUrl,
          notice_type:         row.status,
          estimated_value_usd: row.estimatedValueUsd,
          incumbent:           row.incumbent,
          vehicle:             row.vehicle,
          fit_score:           score.fitScore,
          fit_reason:          score.fitReason,
          red_flags:           score.redFlags,
          recommendation:      recommendationFor(score.fitScore),
          last_scored_at:      scoredAt,
        }));

        const res = await ctx.fetch(
          `${ctx.env.SUPABASE_URL}/rest/v1/opportunities?on_conflict=sam_notice_id`,
          {
            method: "POST",
            headers: sbHeaders(ctx.env, { extra: { Prefer: "resolution=merge-duplicates,return=minimal" } }),
            body: JSON.stringify(rows),
          },
        );
        if (!res.ok) throw new Error(`Supabase upsert → ${res.status}: ${await res.text()}`);
      });
    }

    const values = shortlist.map((x) => x.row.estimatedValueUsd).filter((v): v is number => v !== null);

    return {
      workbooks: opened.map((f) => f.name),
      rows: dataRows,
      mapped: mapped.length,
      selected: selected.length,
      scored: scoredRows.length,
      shortlisted: shortlist.length,
      scoreDistribution,
      totalValueUsd: values.length > 0 ? values.reduce((a, b) => a + b, 0) : null,
      skipped: null,
    };
  },
});
