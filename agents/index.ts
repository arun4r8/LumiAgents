import type { AgentDefinition } from "./types";
import { angie } from "./angie";
import { beady } from "./beady";
import { cleo } from "./cleo";
import { dewey } from "./dewey";
import { patch } from "./patch";
import { money } from "./money";

export type { AgentDefinition, AgentTool, ToolMapping } from "./types";

/**
 * Prompt suggestions for an agent, derived from its tools.
 *
 * The catalogue card used to carry a hand-written suggestedPrompts array seeded
 * by a migration. It drifted immediately: three suggestions against five tools
 * for Angie, and nothing at all for redact_resume. Deriving them from the tools
 * means a new tool brings its own suggestion or fails the guard test.
 *
 * Order follows tool declaration order, which is roughly most to least common.
 */
export function suggestedPromptsFor(slug: string, limit = 6): string[] {
  const agent = AGENTS[slug];
  if (!agent) return [];
  return agent.tools.flatMap((t) => t.examples ?? []).slice(0, limit);
}

export const AGENTS: Record<string, AgentDefinition> = {
  angie,
  beady,
  cleo,
  dewey,
  patch,
  money,
};
