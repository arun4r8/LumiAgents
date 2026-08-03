import { describe, it, expect } from "vitest";
import {
  buildConfigAgentDefinition,
  toolNameFor,
  type CatalogAgentRow,
  type CatalogAgentToolRow,
  type OrchestrationToolMeta,
} from "../../src/agents/catalog-agent";
import {
  validateConfigAgent,
  readOnlyOrchestrations,
  codeAgentSlugs,
  type ConfigAgentDraft,
  type OrchestrationInfo,
} from "../../src/agents/catalog-validation";
import { scopeForConfigAgent, allowedCorporaFor } from "../../src/agents/knowledge-access";

// Tier 1 (#67): a config agent is assembled from catalog data into the same AgentDefinition
// a code agent bundles, then validated at author time against the §3.3 rules.

const ROW: CatalogAgentRow = {
  slug: "insta-cleo",
  display_name: "Insta Cleo",
  card: { emoji: "📸", category: "Eminence", description: "Instagram content." },
  source: "config",
  lifecycle: "active",
  knowledge_corpora: ["shared", "insta-cleo"],
};

// A tiny fake registry: content-plan (async), recent-content (sync/read-only), draft (async w/ params).
const META: Record<string, OrchestrationToolMeta> = {
  "cleo/content-plan": { description: "Plan the calendar.", inputSchema: { type: "object", properties: { theme: { type: "string" } } } },
  "cleo/recent-content": { description: "Recent content.", inputSchema: { type: "object" } },
  "cleo/content-draft": { description: "Draft a post.", inputSchema: { type: "object", properties: { calendarId: { type: "string" } } } },
};
const lookup = (name: string): OrchestrationToolMeta | null => META[name] ?? null;

describe("toolNameFor", () => {
  it("makes an Anthropic-safe tool name from an orchestration name", () => {
    expect(toolNameFor("cleo/content-plan")).toBe("cleo_content-plan");
    expect(toolNameFor("a/b/c")).toBe("a_b_c");
    expect(toolNameFor(`x/${"y".repeat(100)}`).length).toBeLessThanOrEqual(64);
  });
});

describe("buildConfigAgentDefinition", () => {
  const tools: CatalogAgentToolRow[] = [
    { agent_slug: "insta-cleo", orchestration_name: "cleo/content-draft", params: { channel: "instagram" }, mode: "async", position: 1 },
    { agent_slug: "insta-cleo", orchestration_name: "cleo/content-plan", params: null, mode: "async", position: 0 },
    { agent_slug: "insta-cleo", orchestration_name: "cleo/recent-content", params: null, mode: "sync", position: 2 },
  ];

  it("builds tools + toolMap ordered by position, resolving descriptions + schemas", () => {
    const def = buildConfigAgentDefinition(ROW, tools, lookup);
    expect(def.slug).toBe("insta-cleo");
    expect(def.displayName).toBe("Insta Cleo");
    // persona is layered from the override, not the catalog row
    expect(def.systemPrompt).toBe("");
    // ordered by position: content-plan(0), content-draft(1), recent-content(2)
    expect(def.tools.map((t) => t.name)).toEqual([
      "cleo_content-plan", "cleo_content-draft", "cleo_recent-content",
    ]);
    expect(def.tools[0]!.description).toBe("Plan the calendar.");
    expect(def.tools[0]!.inputSchema).toEqual(META["cleo/content-plan"]!.inputSchema);
  });

  it("maps sync mode and merges params under the model input via transform", () => {
    const def = buildConfigAgentDefinition(ROW, tools, lookup);
    expect(def.toolMap["cleo_recent-content"]!.mode).toBe("sync");
    expect(def.toolMap["cleo_content-plan"]!.mode).toBeUndefined();
    const transform = def.toolMap["cleo_content-draft"]!.transform!;
    // author param is a default; the model's explicit input wins on conflict
    expect(transform({ calendarId: "x" })).toEqual({ channel: "instagram", calendarId: "x" });
    expect(transform({ channel: "linkedin" })).toEqual({ channel: "linkedin" });
  });

  it("defensively skips a tool whose orchestration is not registered", () => {
    const withUnknown: CatalogAgentToolRow[] = [
      ...tools,
      { agent_slug: "insta-cleo", orchestration_name: "ghost/does-not-exist", params: null, mode: "async", position: 3 },
    ];
    const def = buildConfigAgentDefinition(ROW, withUnknown, lookup);
    expect(def.tools.find((t) => t.name.includes("ghost"))).toBeUndefined();
    expect(def.tools).toHaveLength(3);
  });
});

describe("readOnlyOrchestrations", () => {
  it("derives the sync-eligible set from the code agents' toolMaps", () => {
    const set = readOnlyOrchestrations();
    // these are marked mode:'sync' by code agents today
    expect(set.has("cleo/recent-content")).toBe(true);
    expect(set.has("cleo/recent-awards")).toBe(true);
    expect(set.has("dewey/knowledge-search")).toBe(true);
    // a mutating/async orchestration must NOT be sync-eligible
    expect(set.has("cleo/content-draft")).toBe(false);
    expect(set.has("cleo/award-sweep")).toBe(false);
  });
});

describe("scopeForConfigAgent", () => {
  it("clamps declared corpora to the agent's allowed set and never restricted", () => {
    const scope = scopeForConfigAgent("insta-cleo", ["shared", "insta-cleo", "restricted", "dewey"]);
    expect(scope.allowedCorpora).toEqual(["shared", "insta-cleo"]); // restricted + dewey dropped
    expect(scope.includeRestricted).toBe(false);
  });

  it("falls back to [shared, ownSlug] when nothing valid is declared", () => {
    expect(scopeForConfigAgent("insta-cleo", null).allowedCorpora).toEqual(["shared", "insta-cleo"]);
    expect(scopeForConfigAgent("insta-cleo", ["restricted"]).allowedCorpora).toEqual(["shared", "insta-cleo"]);
  });

  it("allows the enduser corpus but nothing beyond the allowed set", () => {
    expect(allowedCorporaFor("insta-cleo")).toEqual(["shared", "insta-cleo", "enduser"]);
    expect(scopeForConfigAgent("insta-cleo", ["enduser"]).allowedCorpora).toEqual(["enduser"]);
  });
});

describe("validateConfigAgent", () => {
  const ctx = {
    orchestrations: [
      { name: "cleo/content-plan", isActive: true },
      { name: "cleo/recent-content", isActive: true },
      { name: "cleo/award-sweep", isActive: true },
      { name: "beady/rfi-draft", isActive: false },
    ] as OrchestrationInfo[],
    existingSlugs: ["taken-slug"],
  };

  const valid: ConfigAgentDraft = {
    slug: "insta-cleo",
    displayName: "Insta Cleo",
    card: { emoji: "📸", category: "Eminence", description: "Instagram content." },
    systemPrompt: "You are Insta Cleo. Draft short visual-first captions.",
    model: "claude-sonnet-4-6",
    maxTokens: 2048,
    tools: [
      { orchestrationName: "cleo/content-plan", mode: "async" },
      { orchestrationName: "cleo/recent-content", mode: "sync" },
    ],
    knowledgeCorpora: ["shared", "insta-cleo"],
  };

  it("accepts a well-formed draft", () => {
    expect(validateConfigAgent(valid, ctx)).toEqual({});
  });

  it("rejects a slug that collides with a code agent or an existing catalog agent", () => {
    expect(validateConfigAgent({ ...valid, slug: codeAgentSlugs()[0]! }, ctx).slug).toMatch(/reserved/);
    expect(validateConfigAgent({ ...valid, slug: "taken-slug" }, ctx).slug).toMatch(/already exists/);
  });

  it("rejects a non-kebab-case or empty slug", () => {
    expect(validateConfigAgent({ ...valid, slug: "Insta Cleo" }, ctx).slug).toMatch(/kebab/);
    expect(validateConfigAgent({ ...valid, slug: "" }, ctx).slug).toMatch(/required/);
  });

  it("rejects a model not in MODELS and out-of-range maxTokens", () => {
    expect(validateConfigAgent({ ...valid, model: "gpt-4" }, ctx).model).toBeTruthy();
    expect(validateConfigAgent({ ...valid, maxTokens: 10 }, ctx).maxTokens).toBeTruthy();
  });

  it("rejects unknown, inactive, and duplicate orchestrations", () => {
    expect(validateConfigAgent({ ...valid, tools: [{ orchestrationName: "ghost/x", mode: "async" }] }, ctx).tools).toMatch(/Unknown/);
    expect(validateConfigAgent({ ...valid, tools: [{ orchestrationName: "beady/rfi-draft", mode: "async" }] }, ctx).tools).toMatch(/inactive/);
    expect(validateConfigAgent({ ...valid, tools: [
      { orchestrationName: "cleo/content-plan", mode: "async" },
      { orchestrationName: "cleo/content-plan", mode: "async" },
    ] }, ctx).tools).toMatch(/Duplicate/);
  });

  it("rejects sync mode on a non-read-only orchestration", () => {
    const errs = validateConfigAgent({ ...valid, tools: [{ orchestrationName: "cleo/award-sweep", mode: "sync" }] }, ctx);
    expect(errs.tools).toMatch(/sync/);
  });

  it("rejects at least-one-tool violations", () => {
    expect(validateConfigAgent({ ...valid, tools: [] }, ctx).tools).toMatch(/at least one/);
  });

  it("rejects an empty persona and one over the length cap", () => {
    expect(validateConfigAgent({ ...valid, systemPrompt: "   " }, ctx).systemPrompt).toMatch(/required/);
    expect(validateConfigAgent({ ...valid, systemPrompt: "x".repeat(9000) }, ctx).systemPrompt).toMatch(/8000/);
  });

  it("rejects knowledge corpora outside [shared, ownSlug, enduser] (never restricted)", () => {
    expect(validateConfigAgent({ ...valid, knowledgeCorpora: ["restricted"] }, ctx).knowledgeCorpora).toMatch(/restricted/);
    expect(validateConfigAgent({ ...valid, knowledgeCorpora: ["dewey"] }, ctx).knowledgeCorpora).toMatch(/dewey/);
    expect(validateConfigAgent({ ...valid, knowledgeCorpora: ["shared", "insta-cleo", "enduser"] }, ctx).knowledgeCorpora).toBeUndefined();
  });

  it("requires card fields", () => {
    expect(validateConfigAgent({ ...valid, card: { emoji: "", category: "X", description: "Y" } }, ctx).emoji).toBeTruthy();
    expect(validateConfigAgent({ ...valid, card: { emoji: "📸", category: "", description: "Y" } }, ctx).category).toBeTruthy();
  });
});
