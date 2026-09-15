import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { orchestrations } from "../../src/registry";

/**
 * Every code-registered orchestration must also have a row in
 * orchestration.orchestrations, created by a migration.
 *
 * This exists because #158 shipped `angie/resume-redact` in the registry with no
 * registration migration, and BOTH of its surfaces failed at runtime while every
 * check passed. The shared starter behind /run and /run-sync calls
 * getOrchestrationByName(), which throws when the row is missing, so the feature
 * was dead on arrival in staging and production alike.
 *
 * Nothing could catch it before: the registry is TypeScript, the rows are SQL,
 * and the two are only ever compared at request time against a live database.
 * This test compares them at build time instead.
 *
 * It reads the migration text rather than a database so it runs in plain CI with
 * no credentials. That means it proves a registration was WRITTEN, not that it
 * was APPLIED, which is the half that actually goes wrong when someone adds an
 * orchestration and forgets the SQL.
 */

const SUPABASE_DIR = join(__dirname, "../../../supabase");
const MIGRATIONS_DIR = join(SUPABASE_DIR, "migrations");

/**
 * Every orchestration name the SQL puts in the catalogue.
 *
 * Three shapes have to be recognised, all of them in use:
 *   1. INSERT INTO orchestration.orchestrations in a migration
 *   2. the same INSERT in seed.sql, which is one statement listing many rows
 *   3. UPDATE ... SET name = '...' , which is how the beady -> cleo rename
 *      registered cleo/award-sweep without ever inserting it
 *
 * Missing case 3 is what made the first draft of this test report a dozen
 * false positives, so it is worth keeping the parser honest rather than
 * loosening the assertion.
 */
function registeredInSql(): Set<string> {
  const names = new Set<string>();
  const files = [
    ...readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).map((f) => join(MIGRATIONS_DIR, f)),
    join(SUPABASE_DIR, "seed.sql"),
  ];

  for (const path of files) {
    let sql: string;
    try { sql = readFileSync(path, "utf8"); } catch { continue; }

    for (const stmt of sql.split(/;\s*\n/)) {
      const isInsert = /INSERT\s+INTO\s+orchestration\.orchestrations/i.test(stmt);
      const isRename = /UPDATE\s+orchestration\.orchestrations\s+SET\s+name\s*=/i.test(stmt);
      if (!isInsert && !isRename) continue;
      // Strip comments so a name mentioned in prose does not count as a registration.
      const code = stmt.replace(/--[^\n]*/g, "");
      for (const m of code.matchAll(/'([a-z0-9]+\/[a-z0-9-]+)'/gi)) names.add(m[1]!);
    }
  }
  return names;
}

describe("orchestration registration", () => {
  const inSql = registeredInSql();
  const inCode = [...orchestrations.values()].map((o) => o.name).sort();

  it("finds registration statements at all, so a silent zero cannot pass this suite", () => {
    // Guards the guard: if the parser breaks, every name would look unregistered
    // and the assertion below would fail loudly rather than silently pass.
    expect(inSql.size).toBeGreaterThan(20);
  });

  it("every orchestration in the registry has a registration migration", () => {
    const missing = inCode.filter((name) => !inSql.has(name));
    expect(missing).toEqual([]);
  });
});


/**
 * The reverse direction, which the check above cannot see.
 *
 * `patch/vault-sync` had a registration migration and a route that dispatched it
 * (/api/vault/sync), but was missing from the code registry after the May per-agent
 * workers split. The Workflow resolves orchestrations from the registry, so every run
 * failed with "not registered" -- for four months, unnoticed, because nothing else
 * referenced it. A registry-to-SQL comparison passes that state. This compares the
 * runtime's own literal dispatches against the registry instead.
 */
describe("every orchestration the runtime dispatches by name is registered in code", () => {
  const RUNTIME_SRC = join(__dirname, "../../src");
  const DISPATCH = [
    /getOrchestrationByName\(\s*"([a-z0-9]+\/[a-z0-9-]+)"/g,
    /orchestrationName:\s*"([a-z0-9]+\/[a-z0-9-]+)"/g,
  ];

  function dispatched(): Set<string> {
    const names = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          for (const re of DISPATCH) for (const m of text.matchAll(re)) names.add(m[1]!);
        }
      }
    };
    walk(RUNTIME_SRC);
    return names;
  }

  it("finds dispatch sites at all, so a broken pattern cannot pass silently", () => {
    expect(dispatched().has("patch/vault-sync")).toBe(true);
  });

  it("every dispatched name resolves in the registry", () => {
    const registered = new Set([...orchestrations.values()].map((o) => o.name));
    const missing = [...dispatched()].filter((n) => !registered.has(n));
    expect(missing).toEqual([]);
  });
});
