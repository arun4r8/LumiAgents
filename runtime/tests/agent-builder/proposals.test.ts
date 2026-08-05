import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { statusForPrState } from "../../src/agent-builder/tier2/proposals";
import { applyWranglerServiceEdit, renderWorkerWrangler } from "../../src/agent-builder/tier2/generate-agent";
import type { AgentSpec } from "../../src/agent-builder/tier2/generate-agent";

// Tier 2 (#67), audit fixes 1/2/4: the proposal lifecycle has a way OUT, and a generated agent
// Worker is actually deployable in BOTH environments.

describe("statusForPrState — the pull-based way out of a pending proposal", () => {
  it("merged → merged", () => {
    expect(statusForPrState({ state: "closed", merged: true })).toBe("merged");
  });

  it("closed without merging → closed (the case the design never handled)", () => {
    expect(statusForPrState({ state: "closed", merged: false })).toBe("closed");
  });

  it("still open → null, so the proposal is left alone", () => {
    expect(statusForPrState({ state: "open", merged: false })).toBeNull();
  });
});

// ─── the runtime wrangler.toml edit (production AND staging) ─────────────────────

function spec(): AgentSpec {
  return {
    slug: "sales-scout",
    displayName: "Sales Scout",
    card: {},
    persona: "You are Sales Scout.",
    tools: ["dewey/knowledge-search"],
  };
}

const RUNTIME_WRANGLER = readFileSync(
  join(__dirname, "../../wrangler.toml"),
  "utf8",
);

describe("applyWranglerServiceEdit", () => {
  it("adds the PRODUCTION service binding before [triggers]", () => {
    const out = applyWranglerServiceEdit(RUNTIME_WRANGLER, spec());
    expect(out).toContain('[[services]]\nbinding = "SALES_SCOUT_WORKER"\nservice = "lumiagents-sales-scout"');
    expect(out.indexOf('service = "lumiagents-sales-scout"')).toBeLessThan(out.indexOf("[triggers]"));
  });

  it("ALSO adds the staging twin (wrangler does not inherit services into a named env)", () => {
    const out = applyWranglerServiceEdit(RUNTIME_WRANGLER, spec());
    expect(out).toContain(
      '[[env.staging.services]]\nbinding = "SALES_SCOUT_WORKER"\nservice = "lumiagents-sales-scout-staging"',
    );
  });

  it("puts the staging stanza inside the staging block, before [env.staging.triggers]", () => {
    const out = applyWranglerServiceEdit(RUNTIME_WRANGLER, spec());
    expect(out.indexOf("[env.staging]")).toBeLessThan(out.indexOf("[[env.staging.services]]\nbinding = \"SALES_SCOUT_WORKER\""));
    expect(out.indexOf('service = "lumiagents-sales-scout-staging"')).toBeLessThan(
      out.indexOf("[env.staging.triggers]"),
    );
  });

  it("is idempotent across both environments on a re-draft", () => {
    const once = applyWranglerServiceEdit(RUNTIME_WRANGLER, spec());
    expect(applyWranglerServiceEdit(once, spec())).toBe(once);
  });

  it("still works on a config with no staging block at all", () => {
    const prodOnly = 'name = "x"\n\n[triggers]\ncrons = []\n';
    const out = applyWranglerServiceEdit(prodOnly, spec());
    expect(out).toContain('binding = "SALES_SCOUT_WORKER"');
    expect(out).not.toContain("env.staging");
  });
});

describe("renderWorkerWrangler", () => {
  it("emits an [env.staging] block so the staging deploy loop can pick the Worker up", () => {
    const file = renderWorkerWrangler(spec());
    expect(file.path).toBe("runtime/workers/sales-scout/wrangler.toml");
    expect(file.content).toContain('name = "lumiagents-sales-scout"');
    expect(file.content).toContain("[env.staging]");
    expect(file.content).toContain('name = "lumiagents-sales-scout-staging"');
    expect(file.content).toContain('service = "lumiagents-runtime-staging"');
    expect(file.content).toContain('ENVIRONMENT = "staging"');
  });
});

// ─── the deploy workflows discover agent Workers ────────────────────────────────
// A generated agent Worker only deploys if the workflows stop enumerating the six by hand.
// These assert the property directly against the shipped YAML.

const WORKFLOWS = join(__dirname, "../../../.github/workflows");

describe("deploy workflows", () => {
  for (const file of ["deploy-worker.yml", "deploy-staging.yml"]) {
    describe(file, () => {
      const yaml = readFileSync(join(WORKFLOWS, file), "utf8");

      it("globs runtime/workers/*/wrangler.toml instead of naming each agent", () => {
        expect(yaml).toContain("workers/*/wrangler.toml");
        for (const agent of ["angie", "beady", "patch", "money", "cleo", "dewey"]) {
          expect(yaml).not.toContain(`workers/${agent}/wrangler.toml`);
        }
      });

      it("keeps the ordering rule: agent Workers before the runtime", () => {
        expect(yaml.indexOf("workers/*/wrangler.toml")).toBeLessThan(yaml.indexOf("Deploy Runtime"));
      });
    });
  }
});
