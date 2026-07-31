export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolMapping {
  orchestration: string;
  transform?: (input: Record<string, unknown>) => Record<string, unknown>;
  /**
   * "async" (default): fire-and-forget — dispatches a Cloudflare Workflow and returns
   * {runId, status:"started"} immediately; the chat loop never learns the outcome.
   * "sync": awaits real execution (no Workflow) and returns the orchestration's actual
   * output as the tool_result. Only correct for orchestrations that are provably
   * read-only and fast (no `await_approval`, no mutation) — see run-inline.ts.
   */
  mode?: "sync" | "async";
}

export interface AgentDefinition {
  slug: string;
  displayName: string;
  systemPrompt: string;
  tools: AgentTool[];
  toolMap: Record<string, ToolMapping>;
}
