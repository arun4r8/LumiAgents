import type { AgentDefinition } from "./types";
import { angie } from "./angie";
import { beady } from "./beady";
import { patch } from "./patch";
import { money } from "./money";

export type { AgentDefinition, AgentTool, ToolMapping } from "./types";

export const AGENTS: Record<string, AgentDefinition> = {
  angie,
  beady,
  patch,
  money,
};
