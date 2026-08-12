export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Things a person might actually type to reach this tool, in their words.
   *
   * Lives here rather than in orchestration.agents.card because that is where it
   * drifted: the card's suggestedPrompts were seeded once by a migration, and
   * every tool added since has been invisible to the user. redact_resume shipped
   * with no suggestion at all, while Angie went on offering "Format this resume
   * to our template", which is close enough to a blind-copy request to send
   * someone to the wrong tool.
   *
   * Declaring them next to the tool means adding a tool and forgetting the
   * example is a diff you can see, and a test failure if you miss it.
   */
  examples?: string[];
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
