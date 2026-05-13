export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolMapping {
  orchestration: string;
  transform?: (input: Record<string, unknown>) => Record<string, unknown>;
}

export interface AgentDefinition {
  slug: string;
  displayName: string;
  systemPrompt: string;
  tools: AgentTool[];
  toolMap: Record<string, ToolMapping>;
}
