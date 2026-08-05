import { describe, it, expect } from "vitest";
import {
  executableSql,
  assertNoDestructiveSql,
  assertNoInlineSecrets,
} from "../../src/agent-builder/tier2/guards";
import { renderTableMigration, type TableSpec } from "../../src/agent-builder/tier2/generate-table";

// Tier 2 (#67) safety guards. These are the mechanical backstop behind the human merge, so the
// interesting cases are the BYPASSES the adversarial audit found — not the happy path.

describe("executableSql", () => {
  it("strips whole-line -- comments", () => {
    expect(executableSql("-- a note\nSELECT 1;")).toBe("SELECT 1;");
  });

  it("treats a bare CR as a line break (Postgres ends a -- comment at CR too)", () => {
    // A \n-only split saw ONE line starting with "--" and stripped the whole thing, hiding the
    // DROP from the guard. Postgres would have executed it.
    expect(executableSql("-- rollback:\rDROP TABLE orchestration.runs;")).toBe(
      "DROP TABLE orchestration.runs;",
    );
  });

  it("treats CRLF the same as LF", () => {
    expect(executableSql("-- note\r\nSELECT 1;")).toBe("SELECT 1;");
  });
});

describe("assertNoDestructiveSql", () => {
  it("passes a forward-only migration whose rollback is only a comment", () => {
    expect(() =>
      assertNoDestructiveSql(
        "-- Rollback:\n--   DROP TABLE IF EXISTS orchestration.foo;\n" +
          "CREATE TABLE IF NOT EXISTS orchestration.foo (id uuid);\n",
      ),
    ).not.toThrow();
  });

  it("catches a DROP hidden behind a carriage return inside a comment line", () => {
    const sql = "-- Rollback (do not run):\rDROP TABLE orchestration.agents;\nCREATE TABLE x (id uuid);\n";
    expect(() => assertNoDestructiveSql(sql)).toThrow(/destructive DROP statement/);
  });

  it("catches a TRUNCATE hidden behind a carriage return", () => {
    expect(() => assertNoDestructiveSql("-- note\rTRUNCATE orchestration.runs;")).toThrow(
      /destructive TRUNCATE statement/,
    );
  });

  it("still rejects a plain destructive statement and a non-RLS ALTER", () => {
    expect(() => assertNoDestructiveSql("DELETE FROM orchestration.runs;")).toThrow(/DELETE/);
    expect(() => assertNoDestructiveSql("ALTER TABLE orchestration.runs DROP COLUMN x;")).toThrow(/non-RLS ALTER/);
  });
});

describe("renderTableMigration + the CR guard together", () => {
  function spec(description: string): TableSpec {
    return { tableName: "reels_ideas", columns: [{ name: "theme", type: "text" }], description };
  }

  it("collapses a CR-embedded description so it cannot break out of the -- comment", () => {
    // The description is untrusted ops input interpolated into one `-- ...` line. Stripping only
    // "\n" left "\r" free to end the comment and start an executable statement.
    const migration = renderTableMigration(spec("reel ideas\rDROP TABLE orchestration.agents;"), "20260805000000");
    expect(migration.content).not.toMatch(/\r/);
    expect(() => assertNoDestructiveSql(migration.content)).not.toThrow();
    // The text survives, defanged, on the comment line.
    expect(migration.content).toContain("-- reel ideas DROP TABLE orchestration.agents;");
  });

  it("collapses CRLF and LF alike", () => {
    const migration = renderTableMigration(spec("line one\r\nline two\nline three"), "20260805000000");
    expect(migration.content).toContain("-- line one line two line three");
  });
});

describe("assertNoInlineSecrets", () => {
  it("allows a bare secret NAME (the ops runbook mentions names)", () => {
    expect(() =>
      assertNoInlineSecrets("# provision SALES_SCOUT_API_KEY out-of-band\n", "manifest.yaml"),
    ).not.toThrow();
  });

  it("rejects NAME = \"value\" assignments, private keys and token shapes", () => {
    expect(() => assertNoInlineSecrets('const API_KEY = "abc123";', "f.ts")).toThrow(/inline secret assignment/);
    expect(() => assertNoInlineSecrets("-----BEGIN RSA PRIVATE KEY-----", "f.ts")).toThrow(/private key block/);
    expect(() => assertNoInlineSecrets("sk-abcdefghijklmnopqrstuv", "f.ts")).toThrow(/sk-/);
    expect(() => assertNoInlineSecrets("ghp_abcdefghijklmnopqrstuvwx", "f.ts")).toThrow(/GitHub token/);
  });

  it("names the offending file so the 400 is actionable", () => {
    expect(() => assertNoInlineSecrets('CLIENT_SECRET: "hunter2"', "orchestrations/cleo/x/definition.ts")).toThrow(
      /orchestrations\/cleo\/x\/definition\.ts/,
    );
  });
});
