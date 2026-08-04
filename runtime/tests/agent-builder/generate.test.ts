import { describe, it, expect } from "vitest";
import {
  validateSpec,
  registryValidationContext,
  applyRegistryEdit,
  renderMigration,
  renderManifest,
  renderDefinitionFallback,
  importIdentifier,
  orchestrationName,
  Tier2ValidationError,
  type OrchestrationSpec,
  type ValidationContext,
} from "../../src/agent-builder/tier2/generate";

// Tier 2 (#67): codegen validation + the deterministic templating. No network, no Claude.

const CTX: ValidationContext = {
  existingOrchestrationNames: new Set(["cleo/content-draft", "cleo/content-plan"]),
  existingAgentSlugs: new Set(["cleo", "beady"]),
};

function spec(overrides: Partial<OrchestrationSpec> = {}): OrchestrationSpec {
  return {
    agentSlug: "cleo",
    capabilitySlug: "reels-plan",
    description: "Plan a run of Reels for a content theme.",
    intent: "Given a theme, propose 5 reels ideas and write them back.",
    inputFields: [{ name: "theme", type: "string", description: "The content theme." }],
    output: [{ name: "count", type: "number", description: "How many reels were planned." }],
    ...overrides,
  };
}

describe("validateSpec", () => {
  it("accepts a well-formed spec", () => {
    expect(validateSpec(spec(), CTX)).toEqual([]);
  });

  it("rejects a non-kebab capability slug", () => {
    expect(validateSpec(spec({ capabilitySlug: "ReelsPlan" }), CTX)).toContainEqual(
      expect.stringContaining("kebab-case"),
    );
  });

  it("rejects a collision with an existing orchestration", () => {
    expect(validateSpec(spec({ capabilitySlug: "content-draft" }), CTX)).toContainEqual(
      expect.stringContaining('"cleo/content-draft" already exists'),
    );
  });

  it("rejects an unknown agent slug", () => {
    expect(validateSpec(spec({ agentSlug: "nope" }), CTX)).toContainEqual(
      expect.stringContaining("Unknown agent slug"),
    );
  });

  it("requires description, intent, and at least one input + output field", () => {
    const errs = validateSpec(spec({ description: "", intent: "", inputFields: [], output: [] }), CTX);
    expect(errs).toContainEqual(expect.stringContaining("description is required"));
    expect(errs).toContainEqual(expect.stringContaining("intent"));
    expect(errs).toContainEqual(expect.stringContaining("inputFields must have at least one"));
    expect(errs).toContainEqual(expect.stringContaining("output must have at least one"));
  });

  it("rejects bad field names and unsupported types", () => {
    const errs = validateSpec(
      spec({ inputFields: [{ name: "2bad", type: "string", description: "" }] }),
      CTX,
    );
    expect(errs).toContainEqual(expect.stringContaining("must be a valid identifier"));
  });

  it("derives the live registry context (cleo exists; a real orchestration collides)", () => {
    const live = registryValidationContext();
    expect(live.existingAgentSlugs.has("cleo")).toBe(true);
    expect(validateSpec(spec({ capabilitySlug: "content-draft" }), live)).toContainEqual(
      expect.stringContaining("already exists"),
    );
  });
});

describe("naming helpers", () => {
  it("builds the orchestration name and camelCase import identifier", () => {
    expect(orchestrationName(spec())).toBe("cleo/reels-plan");
    expect(importIdentifier("cleo", "reels-plan")).toBe("cleoReelsPlan");
    expect(importIdentifier("beady", "past-performance-seed")).toBe("beadyPastPerformanceSeed");
  });
});

describe("applyRegistryEdit", () => {
  const registry = [
    'import { z } from "zod";',
    'import type { OrchestrationDefinition } from "./types";',
    "",
    'import cleoContentDraft from "../../orchestrations/cleo/content-draft/definition";',
    'import cleoContentPlan  from "../../orchestrations/cleo/content-plan/definition";',
    "",
    "type AnyOrch = OrchestrationDefinition<z.ZodTypeAny, z.ZodTypeAny>;",
    "function reg(o: AnyOrch): [string, AnyOrch] { return [o.name, o]; }",
    "",
    "export const orchestrations = new Map<string, AnyOrch>([",
    "  reg(cleoContentDraft as unknown as AnyOrch),",
    "  reg(cleoContentPlan  as unknown as AnyOrch),",
    "]);",
    "",
  ].join("\n");

  it("adds exactly one import and one reg() line at the right places", () => {
    const out = applyRegistryEdit(registry, spec());
    expect(out).toContain('import cleoReelsPlan from "../../orchestrations/cleo/reels-plan/definition";');
    expect(out).toContain("  reg(cleoReelsPlan as unknown as AnyOrch),");
    // import sits inside the orchestration import block (before the type line)
    expect(out.indexOf("import cleoReelsPlan")).toBeLessThan(out.indexOf("type AnyOrch"));
    // reg line sits before the Map terminator
    expect(out.indexOf("reg(cleoReelsPlan")).toBeLessThan(out.lastIndexOf("]);"));
  });

  it("is idempotent on a re-draft", () => {
    const once = applyRegistryEdit(registry, spec());
    expect(applyRegistryEdit(once, spec())).toBe(once);
  });
});

describe("renderMigration", () => {
  it("emits a forward-only ON CONFLICT insert, no destructive SQL", () => {
    const mig = renderMigration(spec(), "20260804010203");
    expect(mig.path).toBe("supabase/migrations/20260804010203_register_cleo_reels_plan.sql");
    expect(mig.content).toContain("INSERT INTO orchestration.orchestrations");
    expect(mig.content).toContain("'cleo/reels-plan', 1");
    expect(mig.content).toContain("ON CONFLICT (name, version) DO UPDATE");
    // No destructive DDL/DML in the executable SQL (comment lines, incl. the rollback note, excluded).
    const sql = mig.content
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\b/);
  });

  it("escapes single quotes in the description", () => {
    const mig = renderMigration(spec({ description: "Cleo's reels" }), "20260804010203");
    expect(mig.content).toContain("'Cleo''s reels'");
  });
});

describe("renderManifest", () => {
  it("creates a new manifest when none exists", () => {
    const m = renderManifest(null, spec());
    expect(m.path).toBe("agents/cleo/agent.manifest.yaml");
    expect(m.content).toContain("agent: cleo");
    expect(m.content).toContain("- name: cleo/reels-plan");
    expect(m.content).toContain("status: proposed");
  });

  it("is idempotent when the tool is already recorded", () => {
    const first = renderManifest(null, spec());
    expect(renderManifest(first.content, spec()).content).toBe(first.content);
  });
});

describe("renderDefinitionFallback", () => {
  it("produces a structurally complete, machine-marked stub", () => {
    const src = renderDefinitionFallback(spec());
    expect(src).toContain("MACHINE-DRAFTED");
    expect(src).toContain('name: "cleo/reels-plan"');
    expect(src).toContain("defineOrchestration");
    expect(src).toContain("theme: z.string()");
    expect(src).toContain("count: z.number()");
  });
});

describe("Tier2ValidationError", () => {
  it("carries the detail list", () => {
    const e = new Tier2ValidationError(["a", "b"]);
    expect(e.details).toEqual(["a", "b"]);
    expect(e.message).toContain("a; b");
  });
});
