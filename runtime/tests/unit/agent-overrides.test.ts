import { describe, it, expect } from "vitest";
import {
  resolveSystemPrompt,
  resolveEnabledTools,
  type AgentOverrideInput,
} from "../../src/agents/agent-chat";
import type { AgentTool } from "../../../agents";

// Tier 0 (#67) prompt-layering + tool-filtering. These are the merge rules the chat loop
// applies to an agent's code-defined persona/tools from an agent_config_overrides row.

const BASE = "You are Cleo. Draft LinkedIn posts.";

const TOOLS: AgentTool[] = [
  { name: "plan_calendar", description: "", inputSchema: {} },
  { name: "draft_content", description: "", inputSchema: {} },
  { name: "get_recent_content", description: "", inputSchema: {} },
];

describe("resolveSystemPrompt", () => {
  it("returns the base unchanged when there is no override", () => {
    expect(resolveSystemPrompt(BASE)).toBe(BASE);
    expect(resolveSystemPrompt(BASE, null)).toBe(BASE);
  });

  it("returns the base unchanged when the override prompt is empty/whitespace", () => {
    expect(resolveSystemPrompt(BASE, { systemPrompt: "" })).toBe(BASE);
    expect(resolveSystemPrompt(BASE, { systemPrompt: "   \n " })).toBe(BASE);
    expect(resolveSystemPrompt(BASE, { systemPrompt: null })).toBe(BASE);
  });

  it("appends by default (base + blank line + override)", () => {
    const ovr: AgentOverrideInput = { systemPrompt: "Draft for Instagram instead." };
    expect(resolveSystemPrompt(BASE, ovr)).toBe(`${BASE}\n\nDraft for Instagram instead.`);
  });

  it("appends explicitly when promptStrategy is 'append'", () => {
    const ovr: AgentOverrideInput = { systemPrompt: "Instagram voice.", promptStrategy: "append" };
    expect(resolveSystemPrompt(BASE, ovr)).toBe(`${BASE}\n\nInstagram voice.`);
  });

  it("replaces the base entirely when promptStrategy is 'replace'", () => {
    const ovr: AgentOverrideInput = { systemPrompt: "You are Cleo (Instagram).", promptStrategy: "replace" };
    expect(resolveSystemPrompt(BASE, ovr)).toBe("You are Cleo (Instagram).");
  });

  it("trims the override before layering", () => {
    const ovr: AgentOverrideInput = { systemPrompt: "  Instagram voice.  ", promptStrategy: "append" };
    expect(resolveSystemPrompt(BASE, ovr)).toBe(`${BASE}\n\nInstagram voice.`);
  });
});

describe("resolveEnabledTools", () => {
  it("returns all tools when there is no allow-list", () => {
    expect(resolveEnabledTools(TOOLS)).toBe(TOOLS);
    expect(resolveEnabledTools(TOOLS, null)).toBe(TOOLS);
    expect(resolveEnabledTools(TOOLS, [])).toBe(TOOLS);
  });

  it("filters to the named subset, preserving order", () => {
    const out = resolveEnabledTools(TOOLS, ["draft_content", "plan_calendar"]);
    expect(out.map((t) => t.name)).toEqual(["plan_calendar", "draft_content"]);
  });

  it("ignores unknown tool names", () => {
    const out = resolveEnabledTools(TOOLS, ["draft_content", "nonexistent_tool"]);
    expect(out.map((t) => t.name)).toEqual(["draft_content"]);
  });

  // Previously this fell back to ALL tools "rather than stranding the agent", which
  // inverted the control: a ceiling that fails open is not a ceiling. The realistic
  // trigger is drift, not a bad save -- rename or unregister the last orchestration an
  // agent wired and its stored allow-list matches nothing, silently granting everything.
  it("grants no tools when a non-empty allow-list matches nothing", () => {
    expect(resolveEnabledTools(TOOLS, ["only_bogus_names"])).toEqual([]);
  });

  it("never widens beyond the allow-list", () => {
    // The property that matters: whatever comes back is a subset of both the agent's
    // tools and the allow-list, for every input.
    for (const enabled of [["draft_content"], ["draft_content", "bogus"], ["bogus"]]) {
      const out = resolveEnabledTools(TOOLS, enabled);
      expect(out.every((t) => enabled.includes(t.name))).toBe(true);
      expect(out.every((t) => TOOLS.includes(t))).toBe(true);
    }
  });
});
