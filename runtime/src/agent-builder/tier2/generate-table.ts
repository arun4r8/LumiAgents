// Tier 2 agent builder (#67) — Build 2: new-domain-table codegen.
//
// From a spec { tableName, columns, enduserReadable? } this emits ONE forward-only migration
// that CREATEs a new table in the `orchestration` schema with RLS enabled, an ops-all policy
// (public.is_ops()), an optional enduser read policy (public.is_enduser()), and GRANTs — mirroring
// supabase/migrations/20260709000005_content_calendar.sql and the write-migration SKILL's hard
// rules (RLS in the same migration; forward-only; no destructive DDL). The migration is the whole
// file set; it goes through the identical openPR + human-merge gate as every other kind. Nothing
// is executed here — the SQL ships into a PR as a diff an ops engineer reviews before merge, and
// only then does `supabase db push` apply it, to STAGING (deploy-staging.yml). Production is a
// separate manual promotion (#121, docs/environments.md).

import type { PrFile } from "./pr";
import { defaultTimestamp } from "./generate";
import { Tier2ValidationError } from "./errors";
import { assertNoDestructiveSql } from "./guards";

/** Column types the generator is allowed to emit. Anything else is rejected at validation. */
export const COLUMN_TYPE_ALLOWLIST = [
  "text",
  "int",
  "bigint",
  "boolean",
  "timestamptz",
  "jsonb",
  "uuid",
  "date",
  "numeric",
] as const;
export type ColumnType = (typeof COLUMN_TYPE_ALLOWLIST)[number];

export interface TableColumn {
  name: string;
  type: ColumnType;
  nullable?: boolean; // default true; nullable:false → NOT NULL (safe on a fresh, empty table)
}

/** The new-table proposal an ops user submits. */
export interface TableSpec {
  tableName: string; // snake_case; created as orchestration.<tableName>
  columns: TableColumn[];
  enduserReadable?: boolean; // adds an enduser SELECT policy (public.is_enduser())
  description?: string;
}

export interface TableValidationContext {
  /** Names of tables that already exist (in the orchestration schema) — collision is rejected. */
  existingTableNames: Set<string>;
}

const SNAKE = /^[a-z][a-z0-9_]*$/;
// Columns the generator always adds itself; a spec column may not shadow them.
const RESERVED_COLUMNS = new Set(["id", "created_at", "updated_at"]);
// SQL keywords rejected as bare identifiers (would need quoting and are footguns). Not exhaustive;
// a defensive subset that keeps generated DDL unambiguous and the destructive-SQL guard honest.
const SQL_RESERVED = new Set([
  "drop", "delete", "truncate", "alter", "select", "insert", "update", "table", "from", "where",
  "grant", "user", "order", "group", "primary", "foreign", "default", "constraint", "index",
]);
const MAX_COLUMNS = 40;

/**
 * Validate a table spec before generating anything. Pure, no network, fully testable. Returns the
 * list of problems ([] when valid): snake_case table name that does not already exist; snake_case,
 * non-reserved, unique column names; every type from the allowlist.
 */
export function validateTableSpec(spec: TableSpec, ctx: TableValidationContext): string[] {
  const errors: string[] = [];
  if (!spec || typeof spec !== "object") return ["spec must be an object."];

  if (!spec.tableName || !SNAKE.test(spec.tableName)) {
    errors.push(`tableName "${spec.tableName ?? ""}" must be snake_case (lowercase, digits, underscores; leading letter).`);
  } else if (SQL_RESERVED.has(spec.tableName)) {
    errors.push(`tableName "${spec.tableName}" is a SQL reserved word; choose another name.`);
  } else if (ctx.existingTableNames.has(spec.tableName)) {
    errors.push(`Table "orchestration.${spec.tableName}" already exists; choose a new table name.`);
  }

  if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
    errors.push("columns must have at least one entry.");
  } else {
    if (spec.columns.length > MAX_COLUMNS) errors.push(`columns: too many (${spec.columns.length} > ${MAX_COLUMNS}).`);
    const seen = new Set<string>();
    for (const c of spec.columns) {
      const name = c?.name ?? "";
      if (!SNAKE.test(name)) {
        errors.push(`column "${name}" must be snake_case.`);
        continue;
      }
      if (RESERVED_COLUMNS.has(name)) errors.push(`column "${name}" is reserved (the generator adds it automatically).`);
      if (SQL_RESERVED.has(name)) errors.push(`column "${name}" is a SQL reserved word; choose another name.`);
      if (seen.has(name)) errors.push(`duplicate column "${name}".`);
      seen.add(name);
      if (!COLUMN_TYPE_ALLOWLIST.includes(c.type)) {
        errors.push(`column "${name}" has unsupported type "${String(c?.type)}" (allowed: ${COLUMN_TYPE_ALLOWLIST.join(", ")}).`);
      }
    }
  }
  return errors;
}

// ─── SQL rendering (pure) ────────────────────────────────────────────────────────

const MACHINE_HEADER =
  `-- ⚠️  MACHINE-DRAFTED by the LumiAgents Tier 2 agent builder (#67, Build 2) — REVIEW BEFORE MERGE.\n` +
  `-- A new domain table. Forward-only: CREATE TABLE IF NOT EXISTS + RLS + policies + GRANTs only.\n` +
  `-- No DROP/TRUNCATE/DELETE and no destructive ALTER (the one ALTER enables RLS). It was NOT\n` +
  `-- executed during generation. Since #121, merging applies it to STAGING only\n` +
  `-- (deploy-staging.yml → \`supabase db push\` against the staging project). PRODUCTION is a\n` +
  `-- separate MANUAL promotion — a human runs "Deploy Worker (PRODUCTION — manual)" from the\n` +
  `-- Actions tab. See docs/environments.md, docs/agent-builder-tier2-design.md and\n` +
  `-- .claude/skills/write-migration.\n`;

/** Map an allowlisted spec type to the concrete Postgres type emitted in DDL. */
function pgType(t: ColumnType): string {
  return t === "int" ? "integer" : t;
}

function renderColumnLines(columns: TableColumn[]): string {
  return columns
    .map((c) => `  ${c.name} ${pgType(c.type)}${c.nullable === false ? " NOT NULL" : ""}`)
    .join(",\n");
}

/**
 * Render the forward-only create-table migration. Deterministic; the same spec produces byte-
 * identical SQL every run. Carries the machine-drafted header; the rollback appears ONLY as a
 * comment (never executable). Structure mirrors the content_calendar migration.
 */
export function renderTableMigration(spec: TableSpec, timestamp: string): PrFile {
  const t = spec.tableName;
  const qualified = `orchestration.${t}`;
  const path = `supabase/migrations/${timestamp}_create_${t}.sql`;

  // Collapse EVERY line break (CR as well as LF) to a space. The description is interpolated
  // into a single `-- ...` comment line; Postgres ends a `--` comment at a carriage return too,
  // so stripping only "\n" let a description like "notes\rDROP TABLE orchestration.runs;" break
  // out of the comment into an executable statement (audit #67).
  const desc = spec.description?.trim()
    ? spec.description.trim().replace(/[\r\n]+/g, " ")
    : `New ${t} domain table (machine-drafted).`;

  // NOTE: we intentionally do NOT emit "DROP POLICY IF EXISTS" (it contains DROP). Replay-safety
  // comes from CREATE TABLE IF NOT EXISTS + fresh policy names on a fresh table.
  const body =
    `-- ${desc}\n` +
    `--\n` +
    `-- Migration story for in-flight runs: none — this is a brand-new table; nothing reads it yet.\n` +
    `--\n` +
    `-- Rollback (manual, do not run automatically):\n` +
    `--   DROP TABLE IF EXISTS ${qualified};\n\n` +
    `CREATE TABLE IF NOT EXISTS ${qualified} (\n` +
    `  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),\n` +
    `${renderColumnLines(spec.columns)},\n` +
    `  created_at timestamptz NOT NULL DEFAULT now(),\n` +
    `  updated_at timestamptz NOT NULL DEFAULT now()\n` +
    `);\n\n` +
    `-- RLS enabled in the SAME migration as the table (write-migration SKILL hard rule).\n` +
    `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;\n\n` +
    `CREATE POLICY "${t}_ops_all" ON ${qualified}\n` +
    `  FOR ALL TO authenticated\n` +
    `  USING (public.is_ops())\n` +
    `  WITH CHECK (public.is_ops());\n` +
    (spec.enduserReadable
      ? `\nCREATE POLICY "${t}_enduser_select" ON ${qualified}\n` +
        `  FOR SELECT TO authenticated\n` +
        `  USING (public.is_enduser());\n`
      : `\n-- No enduser policy: this table is ops-only (enduserReadable was not set).\n`) +
    // Conservative grant: SELECT/INSERT/UPDATE to authenticated (RLS still governs); row deletion
    // is left for a human to grant in review if the table needs it — keeps the generated SQL free
    // of the DELETE keyword. service_role (the runtime) bypasses RLS and gets full access.
    `\nGRANT SELECT, INSERT, UPDATE ON ${qualified} TO authenticated;\n` +
    `GRANT ALL ON ${qualified} TO service_role;\n`;

  return { path, content: MACHINE_HEADER + body };
}

// ─── The generator ───────────────────────────────────────────────────────────────

export interface GeneratedTableFileSet {
  tableName: string;
  files: PrFile[];
}

/**
 * Generate the Tier 2 file set for a new domain table: validate (refuse on any error), render the
 * forward-only migration, and screen it through the destructive-SQL guard as a backstop. Returns
 * the file set ready for openPR. Pure aside from the timestamp; no network, no LLM.
 */
export function generateTablePackage(
  spec: TableSpec,
  ctx: TableValidationContext,
  timestamp: string = defaultTimestamp(),
): GeneratedTableFileSet {
  const errors = validateTableSpec(spec, ctx);
  if (errors.length > 0) throw new Tier2ValidationError(errors);

  const migration = renderTableMigration(spec, timestamp);
  assertNoDestructiveSql(migration.content); // belt-and-suspenders: forward-only, non-destructive

  return { tableName: spec.tableName, files: [migration] };
}
