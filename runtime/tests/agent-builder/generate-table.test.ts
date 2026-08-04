import { describe, it, expect } from "vitest";
import {
  validateTableSpec,
  renderTableMigration,
  generateTablePackage,
  COLUMN_TYPE_ALLOWLIST,
  type TableSpec,
  type TableValidationContext,
} from "../../src/agent-builder/tier2/generate-table";
import { assertNoDestructiveSql, executableSql } from "../../src/agent-builder/tier2/guards";
import { Tier2ValidationError } from "../../src/agent-builder/tier2/generate";

// Tier 2 Build 2 (#67): new-table SQL codegen. Pure — no network, no Claude. The load-bearing
// assertions: the generated SQL carries NO destructive keywords and RLS is present.

const CTX: TableValidationContext = { existingTableNames: new Set(["content_calendar"]) };

function spec(overrides: Partial<TableSpec> = {}): TableSpec {
  return {
    tableName: "reels_ideas",
    description: "Reel ideas Cleo plans against.",
    enduserReadable: false,
    columns: [
      { name: "theme", type: "text", nullable: false },
      { name: "score", type: "numeric", nullable: true },
      { name: "meta", type: "jsonb" },
    ],
    ...overrides,
  };
}

describe("validateTableSpec", () => {
  it("accepts a well-formed spec", () => {
    expect(validateTableSpec(spec(), CTX)).toEqual([]);
  });

  it("rejects a non-snake_case table name", () => {
    expect(validateTableSpec(spec({ tableName: "ReelsIdeas" }), CTX)).toContainEqual(
      expect.stringContaining("snake_case"),
    );
  });

  it("rejects a collision with an existing table", () => {
    expect(validateTableSpec(spec({ tableName: "content_calendar" }), CTX)).toContainEqual(
      expect.stringContaining("already exists"),
    );
  });

  it("rejects a type not in the allowlist", () => {
    const errs = validateTableSpec(
      spec({ columns: [{ name: "x", type: "serial" as unknown as TableSpec["columns"][number]["type"] }] }),
      CTX,
    );
    expect(errs.some((e) => e.includes("unsupported type"))).toBe(true);
  });

  it("rejects reserved and duplicate and bad column names", () => {
    const errs = validateTableSpec(
      spec({
        columns: [
          { name: "id", type: "uuid" },
          { name: "theme", type: "text" },
          { name: "theme", type: "text" },
          { name: "2bad", type: "text" },
        ],
      }),
      CTX,
    );
    expect(errs).toContainEqual(expect.stringContaining("reserved"));
    expect(errs).toContainEqual(expect.stringContaining("duplicate"));
    expect(errs).toContainEqual(expect.stringContaining("snake_case"));
  });

  it("requires at least one column", () => {
    expect(validateTableSpec(spec({ columns: [] }), CTX)).toContainEqual(
      expect.stringContaining("at least one"),
    );
  });

  it("allows every allowlisted type", () => {
    const columns = COLUMN_TYPE_ALLOWLIST.map((t, i) => ({ name: `c_${i}`, type: t }));
    expect(validateTableSpec(spec({ columns }), CTX)).toEqual([]);
  });
});

describe("renderTableMigration", () => {
  it("emits CREATE TABLE IF NOT EXISTS in the orchestration schema with the added columns", () => {
    const mig = renderTableMigration(spec(), "20260804010203");
    expect(mig.path).toBe("supabase/migrations/20260804010203_create_reels_ideas.sql");
    expect(mig.content).toContain("CREATE TABLE IF NOT EXISTS orchestration.reels_ideas");
    expect(mig.content).toContain("id uuid PRIMARY KEY DEFAULT gen_random_uuid()");
    expect(mig.content).toContain("theme text NOT NULL");
    expect(mig.content).toContain("score numeric");
    expect(mig.content).toContain("created_at timestamptz NOT NULL DEFAULT now()");
    expect(mig.content).toContain("MACHINE-DRAFTED");
  });

  it("enables RLS and adds an ops-all policy via public.is_ops()", () => {
    const c = renderTableMigration(spec(), "T").content;
    expect(c).toContain("ENABLE ROW LEVEL SECURITY");
    expect(c).toContain('CREATE POLICY "reels_ideas_ops_all"');
    expect(c).toContain("USING (public.is_ops())");
    expect(c).toContain("WITH CHECK (public.is_ops())");
    expect(c).toContain("GRANT ALL ON orchestration.reels_ideas TO service_role");
  });

  it("adds an enduser read policy only when enduserReadable is set", () => {
    expect(renderTableMigration(spec({ enduserReadable: false }), "T").content).not.toContain("_enduser_select");
    const enduser = renderTableMigration(spec({ enduserReadable: true }), "T").content;
    expect(enduser).toContain('CREATE POLICY "reels_ideas_enduser_select"');
    expect(enduser).toContain("USING (public.is_enduser())");
  });

  it("contains NO destructive keyword in the executable SQL (rollback is a comment only)", () => {
    const c = renderTableMigration(spec({ enduserReadable: true }), "T").content;
    // The word DROP appears only inside the commented rollback note.
    const exec = executableSql(c);
    expect(exec).not.toMatch(/\bDROP\b/i);
    expect(exec).not.toMatch(/\bTRUNCATE\b/i);
    expect(exec).not.toMatch(/\bDELETE\b/i);
    // The only ALTER is the non-destructive RLS enable.
    const alters = exec.split(";").map((s) => s.trim()).filter((s) => /\bALTER\b/i.test(s));
    expect(alters.every((s) => /ENABLE ROW LEVEL SECURITY/i.test(s))).toBe(true);
    // The rollback DROP lives in a comment.
    expect(c).toContain("--   DROP TABLE IF EXISTS orchestration.reels_ideas;");
  });

  it("passes the destructive-SQL guard", () => {
    expect(() => assertNoDestructiveSql(renderTableMigration(spec({ enduserReadable: true }), "T").content)).not.toThrow();
  });
});

describe("generateTablePackage", () => {
  it("returns exactly one migration file for a valid spec", () => {
    const pkg = generateTablePackage(spec(), CTX, "20260804010203");
    expect(pkg.files).toHaveLength(1);
    expect(pkg.files[0]!.path).toBe("supabase/migrations/20260804010203_create_reels_ideas.sql");
    expect(pkg.tableName).toBe("reels_ideas");
  });

  it("throws Tier2ValidationError on an invalid spec (no PR, no codegen)", () => {
    expect(() => generateTablePackage(spec({ tableName: "Bad Name" }), CTX)).toThrow(Tier2ValidationError);
  });
});
