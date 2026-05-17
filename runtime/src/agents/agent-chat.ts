import Anthropic from "@anthropic-ai/sdk";
import { AGENTS } from "../../../agents";
import { PDF_REQUIRED_TOOLS, PDF_BATCH_TOOLS, ensurePdfBase64 } from "../utils/pdf";

const MODEL = "claude-sonnet-4-6";
const MAX_TOOL_ROUNDS = 6;

// Minimal env required by the chat loop — lets agent workers import this without the full runtime Env.
export interface AgentEnv {
  ANTHROPIC_API_KEY: string;
}

// ─── Message types ────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface FileAttachment {
  name: string;
  mimeType: string;
  content: string;
}

export interface AgentChatRequest {
  agentSlug: "angie" | "beady" | "patch" | "money";
  messages: ChatMessage[];
  files?: FileAttachment[];
}

export interface AgentChatResponse {
  reply: string;
  runIds: string[];
}

// ─── Tool dispatch ────────────────────────────────────────────────────────────

type ToolInput = Record<string, unknown>;

async function dispatchTool(
  toolName: string,
  toolInput: ToolInput,
  agentSlug: string,
  runtimeUrl: string,
  files?: FileAttachment[],
): Promise<{ result: unknown; runId?: string }> {
  const agent = AGENTS[agentSlug];
  const mapping = agent?.toolMap[toolName];

  if (!mapping) {
    return { result: { error: `Unknown tool: ${toolName}` } };
  }

  let payload = mapping.transform ? mapping.transform(toolInput) : { ...toolInput };

  // Inject PDF attachments for tools that require them.
  if (PDF_REQUIRED_TOOLS.has(toolName) && files?.length) {
    try {
      if (PDF_BATCH_TOOLS.has(toolName)) {
        const pdfBase64s = await Promise.all(files.map(ensurePdfBase64));
        payload = { ...payload, pdfBase64s };
      } else {
        // Single-file tools: use the first attached file.
        const pdfBase64 = await ensurePdfBase64(files[0]!);
        payload = { ...payload, solicitationPdfBase64: pdfBase64 };
      }
    } catch (err) {
      return { result: { error: err instanceof Error ? err.message : "PDF conversion failed" } };
    }
  }

  const resp = await fetch(
    `${runtimeUrl}/api/orchestrations/${encodeURIComponent(mapping.orchestration)}/run`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  const data = (await resp.json()) as { runId?: string; output?: unknown; error?: string };

  if (!resp.ok) {
    return { result: { error: data.error ?? `HTTP ${resp.status}` } };
  }

  return {
    ...(data.runId !== undefined && { runId: data.runId }),
    result: {
      runId: data.runId ?? null,
      status: "started",
      message: `Orchestration started. Run ID: ${data.runId}`,
      output: data.output ?? null,
    },
  };
}

// ─── Main chat loop ───────────────────────────────────────────────────────────

export async function runAgentChat(
  env: AgentEnv,
  request: AgentChatRequest,
  runtimeUrl: string,
): Promise<AgentChatResponse> {
  const agent = AGENTS[request.agentSlug];
  if (!agent) throw new Error(`Unknown agent slug: ${request.agentSlug}`);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const runIds: string[] = [];

  const messages: Anthropic.MessageParam[] = request.messages.map((m, i) => {
    const isLast = i === request.messages.length - 1;
    if (isLast && m.role === "user" && request.files?.length) {
      const fileContextParts: Anthropic.TextBlockParam[] = request.files.map((f) => ({
        type: "text",
        text: `\n\n---\n**File: ${f.name}** (${f.mimeType})\n\`\`\`\n${f.content}\n\`\`\``,
      }));
      return {
        role: "user",
        content: [{ type: "text", text: m.content }, ...fileContextParts],
      };
    }
    return { role: m.role, content: m.content };
  });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: agent.systemPrompt,
      tools: agent.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
      })),
      messages,
    });

    if (response.stop_reason === "end_turn") {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { reply: text, runIds };
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { reply: text || "Done.", runIds };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const { result, runId } = await dispatchTool(
          block.name,
          block.input as ToolInput,
          request.agentSlug,
          runtimeUrl,
          request.files,
        );
        if (runId) runIds.push(runId);
        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      }),
    );

    messages.push({ role: "user", content: toolResults });
  }

  return {
    reply: "I've completed the requested actions. Check the run links above for details.",
    runIds,
  };
}
