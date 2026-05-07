import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { RunContext } from "../types";
import { SupabaseClient } from "../db/client";
import { PauseSignal } from "./pause";

const MODEL = "claude-sonnet-4-6";

function makeClient(ctx: RunContext): Anthropic {
  return new Anthropic({ apiKey: ctx.env.ANTHROPIC_API_KEY });
}

// ─── llm_decide ──────────────────────────────────────────────────────────────

export async function llm_decide<const T extends string>(
  ctx: RunContext,
  options: {
    name: string;
    prompt: string;
    input: unknown;
    options: T[];
  },
): Promise<T> {
  const db = new SupabaseClient(ctx.env);
  const idx = ctx.stepIndex();

  // Replay short-circuit
  const cached = await db.getCompletedStep(ctx.runId, idx);
  if (cached !== null) {
    return (cached.output as { chosen: T }).chosen;
  }

  const systemPrompt = `You are a decision engine. Given the context, choose exactly one of the following options and respond with ONLY that option text, nothing else:\n${options.options.map((o) => `- ${o}`).join("\n")}`;

  const userPrompt = `${options.prompt}\n\nContext:\n${JSON.stringify(options.input, null, 2)}`;

  const runStep = await db.createRunStep({
    run_id: ctx.runId,
    step_index: idx,
    step_name: options.name,
    step_type: "llm_decide",
    status: "running",
    input: { prompt: options.prompt, options: options.options, context: options.input },
  });

  try {
    const client = makeClient(ctx);
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 64,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const raw = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
    const chosen = options.options.find((o) => o === raw);

    if (!chosen) {
      throw new Error(`Model returned "${raw}" which is not in options: ${options.options.join(", ")}`);
    }

    await db.updateRunStep(runStep.id, {
      status: "completed",
      output: { chosen },
      llm_model: MODEL,
      llm_prompt: userPrompt,
      llm_response: raw,
      llm_input_tokens: response.usage.input_tokens,
      llm_output_tokens: response.usage.output_tokens,
      ended_at: new Date().toISOString(),
    });

    return chosen;
  } catch (err) {
    await db.updateRunStep(runStep.id, {
      status: "failed",
      error: { message: err instanceof Error ? err.message : String(err) },
      ended_at: new Date().toISOString(),
    });
    throw err;
  }
}

// ─── llm_extract ─────────────────────────────────────────────────────────────

export async function llm_extract<T extends z.ZodTypeAny>(
  ctx: RunContext,
  options: {
    name: string;
    prompt: string;
    input: unknown;
    schema: T;
  },
): Promise<z.infer<T>> {
  const db = new SupabaseClient(ctx.env);
  const idx = ctx.stepIndex();

  // Replay short-circuit
  const cached = await db.getCompletedStep(ctx.runId, idx);
  if (cached !== null) {
    return cached.output as z.infer<T>;
  }

  // Suppress unused import warning from the PauseSignal import above
  void PauseSignal;

  const runStep = await db.createRunStep({
    run_id: ctx.runId,
    step_index: idx,
    step_name: options.name,
    step_type: "llm_extract",
    status: "running",
    input: { prompt: options.prompt, context: options.input },
  });

  try {
    const client = makeClient(ctx);

    // Use tool use for structured extraction
    const toolSchema = zodToJsonSchema(options.schema);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: [
        {
          name: "extract",
          description: "Extract structured data from the provided context",
          input_schema: toolSchema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: "extract" },
      messages: [
        {
          role: "user",
          content: `${options.prompt}\n\nContext:\n${JSON.stringify(options.input, null, 2)}`,
        },
      ],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Model did not call the extract tool");
    }

    const parsed = options.schema.parse(toolUse.input);

    await db.updateRunStep(runStep.id, {
      status: "completed",
      output: parsed,
      llm_model: MODEL,
      llm_prompt: options.prompt,
      llm_response: JSON.stringify(toolUse.input),
      llm_input_tokens: response.usage.input_tokens,
      llm_output_tokens: response.usage.output_tokens,
      ended_at: new Date().toISOString(),
    });

    return parsed;
  } catch (err) {
    await db.updateRunStep(runStep.id, {
      status: "failed",
      error: { message: err instanceof Error ? err.message : String(err) },
      ended_at: new Date().toISOString(),
    });
    throw err;
  }
}

// Minimal zod → JSON Schema converter for tool use (handles common cases)
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(val);
      if (!(val instanceof z.ZodOptional)) required.push(key);
    }

    return { type: "object", properties, required };
  }

  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray) return { type: "array", items: zodToJsonSchema(schema.element) };
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodNullable) return { ...zodToJsonSchema(schema.unwrap()), nullable: true };

  return {};
}
