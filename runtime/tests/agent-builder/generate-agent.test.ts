import { describe, it, expect } from "vitest";
import type { Env } from "../../src/types";
import type { GhAppFetch } from "../../src/integrations/github/app-auth";
import {
  validateAgentSpec,
  agentValidationContext,
  renderAgentIndex,
  renderAgentSeedMigration,
  renderAgentManifest,
  applyAgentsIndexEdit,
  applyAgentSlugUnionEdit,
  applyAgentBindingsEdit,
  applyWorkerBindingTypeEdit,
  applyWranglerServiceEdit,
  camelIdentifier,
  screamingSnake,
  toolNameFor,
  generateAgentPackage,
  type AgentSpec,
  type AgentValidationContext,
} from "../../src/agent-builder/tier2/generate-agent";
import { assertNoInlineSecrets } from "../../src/agent-builder/tier2/guards";
import { Tier2ValidationError } from "../../src/agent-builder/tier2/generate";

// Tier 2 Build 2 (#67): new dedicated-Worker agent scaffold codegen. The load-bearing assertions:
// ONLY existing orchestrations are wired, and NO generated file inlines a secret value.

const CTX: AgentValidationContext = {
  existingAgentSlugs: new Set(["cleo", "beady", "money"]),
  existingOrchestrationNames: new Set(["dewey/knowledge-search", "cleo/content-plan"]),
};

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    slug: "sales-scout",
    displayName: "Sales Scout",
    card: { emoji: "🔭", category: "BD", description: "Scouts leads.", suggestedPrompts: ["Find leads"] },
    persona: "You are Sales Scout, Lumiture's BD assistant.",
    tools: ["dewey/knowledge-search", "cleo/content-plan"],
    secrets: ["SALES_SCOUT_API_KEY"],
    ...overrides,
  };
}

describe("validateAgentSpec", () => {
  it("accepts a well-formed spec", () => {
    expect(validateAgentSpec(spec(), CTX)).toEqual([]);
  });

  it("rejects a non-kebab slug", () => {
    expect(validateAgentSpec(spec({ slug: "SalesScout" }), CTX)).toContainEqual(expect.stringContaining("kebab-case"));
  });

  it("rejects a slug that collides with an existing agent", () => {
    expect(validateAgentSpec(spec({ slug: "cleo" }), CTX)).toContainEqual(expect.stringContaining("already exists"));
  });

  it("rejects a tool that is not an existing orchestration (never wires new/unknown tools)", () => {
    expect(validateAgentSpec(spec({ tools: ["dewey/knowledge-search", "cleo/does-not-exist"] }), CTX)).toContainEqual(
      expect.stringContaining("not an existing orchestration"),
    );
  });

  it("rejects duplicate tools and an empty tool list", () => {
    expect(validateAgentSpec(spec({ tools: ["cleo/content-plan", "cleo/content-plan"] }), CTX)).toContainEqual(
      expect.stringContaining("duplicate tool"),
    );
    expect(validateAgentSpec(spec({ tools: [] }), CTX)).toContainEqual(expect.stringContaining("at least one"));
  });

  it("requires a display name and persona", () => {
    const errs = validateAgentSpec(spec({ displayName: "", persona: "" }), CTX);
    expect(errs).toContainEqual(expect.stringContaining("displayName is required"));
    expect(errs).toContainEqual(expect.stringContaining("persona is required"));
  });

  it("rejects a secret that looks like a value rather than a NAME", () => {
    expect(validateAgentSpec(spec({ secrets: ["sk-livekey123"] }), CTX)).toContainEqual(
      expect.stringContaining("must be a NAME"),
    );
  });

  it("derives a live context that knows the real code agents + orchestrations", () => {
    const live = agentValidationContext();
    expect(live.existingAgentSlugs.has("cleo")).toBe(true);
    expect(live.existingOrchestrationNames.has("dewey/knowledge-search")).toBe(true);
  });
});

describe("naming helpers", () => {
  it("builds identifiers", () => {
    expect(camelIdentifier("sales-scout")).toBe("salesScout");
    expect(screamingSnake("sales-scout")).toBe("SALES_SCOUT");
    expect(toolNameFor("dewey/knowledge-search")).toBe("knowledge_search");
  });
});

describe("renderAgentIndex", () => {
  it("wires ONLY the spec's existing orchestrations into the toolMap", () => {
    const src = renderAgentIndex(spec());
    expect(src).toContain("export const salesScout: AgentDefinition");
    expect(src).toContain('slug: "sales-scout"');
    expect(src).toContain("You are Sales Scout");
    expect(src).toContain('knowledge_search: { orchestration: "dewey/knowledge-search" }');
    expect(src).toContain('content_plan: { orchestration: "cleo/content-plan" }');
    // No orchestration other than the two requested appears anywhere.
    expect(src).not.toContain("award-sweep");
    expect(src).not.toContain("content-draft");
  });

  it("escapes a persona containing backticks/interpolation so the template literal stays safe", () => {
    const src = renderAgentIndex(spec({ persona: "use `code` and ${danger}" }));
    expect(src).toContain("\\`code\\`");
    expect(src).toContain("\\${danger}");
  });

  it("never inlines a secret value", () => {
    expect(() => assertNoInlineSecrets(renderAgentIndex(spec()), "index.ts")).not.toThrow();
  });
});

describe("renderAgentSeedMigration + manifest", () => {
  it("seeds the agents catalog row as source='code' with a forward-only INSERT", () => {
    const mig = renderAgentSeedMigration(spec(), "20260804010203");
    expect(mig.path).toBe("supabase/migrations/20260804010203_register_agent_sales_scout.sql");
    expect(mig.content).toContain("INSERT INTO orchestration.agents");
    expect(mig.content).toContain("'sales-scout', 'Sales Scout', 'code'");
    expect(mig.content).toContain("ON CONFLICT (slug) DO NOTHING");
    // No destructive DDL/DML in the executable SQL.
    const exec = mig.content.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(exec).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\b|\bALTER\b/i);
  });

  it("records the agent, its tools, and secret NAMES (values never inlined) in the manifest", () => {
    const m = renderAgentManifest(spec());
    expect(m.path).toBe("agents/sales-scout/agent.manifest.yaml");
    expect(m.content).toContain("agent: sales-scout");
    expect(m.content).toContain("source: code");
    expect(m.content).toContain("- dewey/knowledge-search");
    expect(m.content).toContain("- SALES_SCOUT_API_KEY");
    expect(() => assertNoInlineSecrets(m.content, "manifest")).not.toThrow();
  });
});

describe("wiring edits", () => {
  it("adds the import + AGENTS entry to agents/index.ts", () => {
    const current = [
      'import type { AgentDefinition } from "./types";',
      'import { money } from "./money";',
      "",
      "export const AGENTS: Record<string, AgentDefinition> = {",
      "  money,",
      "};",
    ].join("\n");
    const out = applyAgentsIndexEdit(current, spec());
    expect(out).toContain('import { salesScout } from "./sales-scout";');
    expect(out).toContain('  "sales-scout": salesScout,');
    // idempotent
    expect(applyAgentsIndexEdit(out, spec())).toBe(out);
  });

  it("extends the AgentSlug union", () => {
    const out = applyAgentSlugUnionEdit('export type AgentSlug = "angie" | "money";', spec());
    expect(out).toBe('export type AgentSlug = "angie" | "money" | "sales-scout";');
    expect(applyAgentSlugUnionEdit(out, spec())).toBe(out); // idempotent
  });

  it("adds the AGENT_BINDINGS entry", () => {
    const current = [
      "const AGENT_BINDINGS: Record<AgentSlug, keyof Env> = {",
      '  money: "MONEY_WORKER",',
      "};",
    ].join("\n");
    const out = applyAgentBindingsEdit(current, spec());
    expect(out).toContain('  "sales-scout": "SALES_SCOUT_WORKER",');
  });

  it("adds the Env Fetcher binding", () => {
    const out = applyWorkerBindingTypeEdit("  MONEY_WORKER?: Fetcher;", spec());
    expect(out).toContain("  SALES_SCOUT_WORKER?: Fetcher;");
  });

  it("adds the wrangler service stanza before [triggers]", () => {
    const out = applyWranglerServiceEdit("[vars]\nx=1\n\n[triggers]\ncrons=[]\n", spec());
    expect(out).toContain('binding = "SALES_SCOUT_WORKER"');
    expect(out).toContain('service = "lumiagents-sales-scout"');
    expect(out.indexOf("SALES_SCOUT_WORKER")).toBeLessThan(out.indexOf("[triggers]"));
  });
});

// ─── generateAgentPackage with a fake ghAppFetch (no network) ────────────────────────

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

const REPO_FILES: Record<string, string> = {
  "agents/index.ts": [
    'import type { AgentDefinition } from "./types";',
    'import { money } from "./money";',
    "",
    "export const AGENTS: Record<string, AgentDefinition> = {",
    "  money,",
    "};",
  ].join("\n"),
  "runtime/src/agents/agent-chat.ts": 'export type AgentSlug = "angie" | "money";',
  "runtime/src/routes/agents.ts": [
    "const AGENT_BINDINGS: Record<AgentSlug, keyof Env> = {",
    '  money: "MONEY_WORKER",',
    "};",
  ].join("\n"),
  "runtime/src/types/index.ts": "  MONEY_WORKER?: Fetcher;",
  "runtime/wrangler.toml": "[vars]\nx=1\n\n[triggers]\ncrons=[]\n",
};

function fakeGh(): GhAppFetch {
  return (async (_env: Env, path: string) => {
    const key = Object.keys(REPO_FILES).find((p) => path.includes(encodeURIComponent(p)) || path.includes(p));
    if (!key) throw new Error(`unexpected path ${path}`);
    return { content: b64(REPO_FILES[key] as string), encoding: "base64" };
  }) as unknown as GhAppFetch;
}

const ENV = {} as unknown as Env;

describe("generateAgentPackage", () => {
  it("assembles the full scaffold + wiring edits, wiring only existing tools and no inline secrets", async () => {
    const pkg = await generateAgentPackage(ENV, spec(), { ghAppFetch: fakeGh(), timestamp: "20260804010203" });
    const paths = pkg.files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "agents/sales-scout/index.ts",
        "runtime/src/workers/sales-scout.ts",
        "runtime/workers/sales-scout/wrangler.toml",
        "supabase/migrations/20260804010203_register_agent_sales_scout.sql",
        "agents/sales-scout/agent.manifest.yaml",
        "agents/index.ts",
        "runtime/src/agents/agent-chat.ts",
        "runtime/src/routes/agents.ts",
        "runtime/src/types/index.ts",
        "runtime/wrangler.toml",
      ]),
    );
    expect(pkg.secretsNeeded).toEqual(["SALES_SCOUT_API_KEY"]);

    // No generated file inlines a secret value.
    for (const f of pkg.files) expect(() => assertNoInlineSecrets(f.content, f.path)).not.toThrow();

    // The edited AgentSlug union + bindings carry the new slug.
    const slugUnion = pkg.files.find((f) => f.path === "runtime/src/agents/agent-chat.ts")!.content;
    expect(slugUnion).toContain('"sales-scout"');
    const bindings = pkg.files.find((f) => f.path === "runtime/src/routes/agents.ts")!.content;
    expect(bindings).toContain('"sales-scout": "SALES_SCOUT_WORKER"');
  });

  it("refuses (throws) a persona carrying a secret value — nothing is generated for a PR", async () => {
    await expect(
      generateAgentPackage(ENV, spec({ persona: "key: -----BEGIN PRIVATE KEY-----\\nMIIabc" }), {
        ghAppFetch: fakeGh(),
      }),
    ).rejects.toBeInstanceOf(Tier2ValidationError);
  });

  it("refuses an unknown tool before any repo read", async () => {
    await expect(
      generateAgentPackage(ENV, spec({ tools: ["cleo/not-real"] }), { ghAppFetch: fakeGh() }),
    ).rejects.toBeInstanceOf(Tier2ValidationError);
  });
});
