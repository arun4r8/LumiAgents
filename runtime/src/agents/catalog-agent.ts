// Tier 1 agent builder (#67) — assemble an AgentDefinition on the fly from catalog data.
//
// A config agent has no agents/<slug>/index.ts and no dedicated Worker. When a chat request
// targets one, routes/agents.ts reads its catalog row + agent_tools rows and calls
// buildConfigAgentDefinition() to produce the exact same AgentDefinition shape a code agent
// bundles — persona (systemPrompt), tools[] (name/description/inputSchema), and toolMap
// (orchestration + mode + params-as-transform). That definition is threaded into the
// existing inline runAgentChat via AgentChatRequest.agentDef, so a config agent runs through
// the identical chat loop + tool-dispatch path as a code agent, just resolved from data.

import type { AgentDefinition, AgentTool, ToolMapping } from "../../../agents";

/** A catalog agents row (orchestration.agents). */
export interface CatalogAgentRow {
  slug: string;
  display_name: string;
  card: unknown | null;
  source: "config" | "code";
  lifecycle: "active" | "disabled";
  knowledge_corpora: string[] | null;
}

/** An agent_tools row (orchestration.agent_tools). */
export interface CatalogAgentToolRow {
  agent_slug: string;
  orchestration_name: string;
  params: Record<string, unknown> | null;
  mode: "async" | "sync";
  position: number | null;
}

/** Just enough about a registered orchestration to expose it as a tool to the LLM. */
export interface OrchestrationToolMeta {
  description: string | null;
  inputSchema: Record<string, unknown>;
}

/** Anthropic tool names allow [a-zA-Z0-9_-]{1,64}; make a stable one from the orch name. */
export function toolNameFor(orchestrationName: string): string {
  return orchestrationName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * Build the AgentDefinition for a config agent from its catalog row + tool rows. `lookup`
 * resolves each orchestration_name to its description + JSON input schema (from the code
 * registry). Tools whose orchestration is not registered are skipped defensively — a config
 * agent can only ever expose vetted, registered orchestrations.
 */
export function buildConfigAgentDefinition(
  row: CatalogAgentRow,
  toolRows: CatalogAgentToolRow[],
  lookup: (orchestrationName: string) => OrchestrationToolMeta | null,
): AgentDefinition {
  const tools: AgentTool[] = [];
  const toolMap: Record<string, ToolMapping> = {};

  const sorted = [...toolRows].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );

  for (const t of sorted) {
    const meta = lookup(t.orchestration_name);
    if (!meta) continue; // unregistered orchestration → not exposed
    const name = toolNameFor(t.orchestration_name);

    tools.push({
      name,
      description: meta.description ?? t.orchestration_name,
      inputSchema: meta.inputSchema,
    });

    const params = t.params && typeof t.params === "object" ? t.params : null;
    const mapping: ToolMapping = { orchestration: t.orchestration_name };
    if (t.mode === "sync") mapping.mode = "sync";
    if (params) {
      // params are author-set defaults merged UNDER the model's tool input, matching how a
      // code agent's ToolMapping.transform folds in fixed fields (e.g. channel: instagram).
      mapping.transform = (input: Record<string, unknown>) => ({ ...params, ...input });
    }
    toolMap[name] = mapping;
  }

  return {
    slug: row.slug,
    displayName: row.display_name,
    systemPrompt: "", // persona is layered from the override (agent_config_overrides) by the caller
    tools,
    toolMap,
  };
}
