import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  scopeForAgent,
  scopeForRun,
  scopeForConfigAgent,
  allowedCorporaFor,
  SHARED_CORPUS,
  ENDUSER_CORPUS,
} from "../../src/agents/knowledge-access";

/**
 * #177 — a config agent must retrieve under ITS OWN declared scope, not under the
 * scope of whatever orchestration it happens to wire.
 *
 * The bug: `dewey/knowledge-search` called `scopeForAgent("dewey")` unconditionally,
 * so a config agent that wired it read dewey's private corpus regardless of its own
 * `knowledge_corpora`. The declared scope was validated and stored, and then ignored.
 */

describe("scopeForRun", () => {
  it("prefers the caller's scope over the orchestration's own", () => {
    const callerScope = scopeForConfigAgent("sales-scout", ["shared"]);
    const scope = scopeForRun({ knowledgeScope: callerScope }, "dewey");

    expect(scope.allowedCorpora).toEqual(["shared"]);
    // The whole point: dewey's private corpus is NOT reachable through dewey's own
    // orchestration when the caller is someone else.
    expect(scope.allowedCorpora).not.toContain("dewey");
  });

  it("falls back to the donor's own scope for a direct run", () => {
    // No initiating agent (a scheduled run, or a direct ops call) — pre-#177 behaviour,
    // which remains correct there.
    expect(scopeForRun({}, "dewey")).toEqual(scopeForAgent("dewey"));
  });

  it("is a no-op for a code agent calling its own orchestration", () => {
    // Each of the six code agents wires only its own retrieval orchestration, so caller
    // and donor slug coincide and behaviour is identical to before #177.
    const scope = scopeForRun({ knowledgeScope: scopeForAgent("dewey") }, "dewey");
    expect(scope).toEqual(scopeForAgent("dewey"));
  });

  it("never grants restricted sensitivity through a caller scope", () => {
    const scope = scopeForRun(
      { knowledgeScope: scopeForConfigAgent("sales-scout", ["shared"]) },
      "dewey",
    );
    expect(scope.includeRestricted).toBe(false);
  });
});

describe("scopeForConfigAgent", () => {
  it("drops another agent's private corpus from a declaration", () => {
    const scope = scopeForConfigAgent("sales-scout", ["shared", "dewey", "patch"]);
    expect(scope.allowedCorpora).toEqual(["shared"]);
  });

  it("drops a 'restricted' declaration", () => {
    const scope = scopeForConfigAgent("sales-scout", ["shared", "restricted"]);
    expect(scope.allowedCorpora).toEqual(["shared"]);
    expect(scope.includeRestricted).toBe(false);
  });

  it("falls back to [shared, ownSlug] when nothing is declared", () => {
    expect(scopeForConfigAgent("sales-scout", null).allowedCorpora)
      .toEqual([SHARED_CORPUS, "sales-scout"]);
    expect(scopeForConfigAgent("sales-scout", []).allowedCorpora)
      .toEqual([SHARED_CORPUS, "sales-scout"]);
  });

  it("allows exactly [shared, ownSlug, enduser] and nothing else", () => {
    expect(allowedCorporaFor("sales-scout"))
      .toEqual([SHARED_CORPUS, "sales-scout", ENDUSER_CORPUS]);
    const scope = scopeForConfigAgent("sales-scout", [SHARED_CORPUS, "sales-scout", ENDUSER_CORPUS]);
    expect(scope.allowedCorpora).toEqual([SHARED_CORPUS, "sales-scout", ENDUSER_CORPUS]);
  });
});

/**
 * Guard: the bug was a hardcoded donor slug at the retrieval call site. If a future
 * orchestration reaches for `scopeForAgent("<literal>")` again, the enforcement is
 * silently bypassed for that orchestration only -- exactly how this survived review
 * the first time. Fail the build instead.
 */
describe("no orchestration hardcodes its own retrieval scope", () => {
  const ROOT = join(__dirname, "../../../orchestrations");

  function definitionFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...definitionFiles(p));
      else if (entry.name === "definition.ts") out.push(p);
    }
    return out;
  }

  it("uses scopeForRun(ctx, ...) rather than scopeForAgent(\"literal\")", () => {
    const offenders = definitionFiles(ROOT).filter((f) =>
      /scopeForAgent\(\s*["'][a-z-]+["']\s*\)/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  it("finds the retrieval orchestrations it is meant to be guarding", () => {
    // A guard that matches nothing passes forever. Assert the corpus it scans is real.
    const files = definitionFiles(ROOT);
    const usingScope = files.filter((f) => /scopeForRun\(/.test(readFileSync(f, "utf8")));
    expect(usingScope.length).toBeGreaterThanOrEqual(3);
  });
});
