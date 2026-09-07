import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "../../../integrations/anthropic/client";
import { z } from "zod";
import type { RunContext } from "../types";
import { SupabaseClient } from "../db/client";
import { MODELS } from "../config/models";

/**
 * Default output cap for llm_extract. Fine for a handful of fields; too small for
 * an array whose length tracks the input. A truncated response is not reported as
 * truncation -- the JSON is cut mid-object and Zod rejects it, so it arrives as a
 * bare ZodError. Callers returning a list should raise this deliberately.
 */
export const LLM_EXTRACT_DEFAULT_MAX_TOKENS = 4096;

/**
 * Turn a truncated extraction into an error that says so.
 *
 * When the model hits `max_tokens` mid-answer, the tool-use JSON is simply cut off.
 * Nothing in the response object says "truncated" at the point we parse it: Zod
 * rejects the malformed input and the step fails with a bare `ZodError`. That cost
 * three production runs of beady/opportunity-sweep before anyone thought to
 * question the token cap, because the error pointed at the schema instead.
 *
 * `stop_reason` is the signal, and checking it before parsing means the next
 * caller to outgrow the cap is told which knob to turn.
 */
export function assertNotTruncated(stopReason: string | null, name: string, maxTokens: number): void {
  if (stopReason !== "max_tokens") return;
  throw new Error(
    `llm_extract("${name}") hit the ${maxTokens}-token output cap and the response was cut off mid-answer. ` +
      `This is not a schema problem. Either raise \`maxTokens\` on this call or send fewer items per call: ` +
      `a schema returning an array costs roughly (items x per-item tokens), so the cap has to scale with the input.`,
  );
}


const DEFAULT_MODEL: string = MODELS.sonnet;

function makeClient(ctx: RunContext): Anthropic {
  return anthropicClient(ctx.env.ANTHROPIC_API_KEY);
}

function resolveModel(ctx: RunContext): string {
  return ctx.model ?? DEFAULT_MODEL;
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

  // In Workflow mode, wrap the LLM call in step.do() for durability + retry
  if (ctx.workflowStep) {
    try {
      const result = await ctx.workflowStep.do(`llm-decide-${idx}`, {
        retries: { limit: 2, delay: "10 seconds", backoff: "linear" },
      }, async () => {
        const client = makeClient(ctx);
        const response = await client.messages.create({
          model: resolveModel(ctx), max_tokens: 64,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        });
        const raw = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
        const chosen = options.options.find((o) => o === raw);
        if (!chosen) throw new Error(`Model returned "${raw}" which is not in options: ${options.options.join(", ")}`);
        return { chosen, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, raw };
      });

      await db.updateRunStep(runStep.id, {
        status: "completed",
        output: { chosen: result.chosen },
        llm_model: resolveModel(ctx),
        llm_prompt: userPrompt,
        llm_response: result.raw,
        llm_input_tokens: result.inputTokens,
        llm_output_tokens: result.outputTokens,
        ended_at: new Date().toISOString(),
      });
      return result.chosen;
    } catch (err) {
      await db.updateRunStep(runStep.id, {
        status: "failed",
        error: { message: err instanceof Error ? err.message : String(err) },
        ended_at: new Date().toISOString(),
      });
      throw err;
    }
  }

  try {
    const client = makeClient(ctx);
    const response = await client.messages.create({
      model: resolveModel(ctx),
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
      llm_model: resolveModel(ctx),
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

/**
 * A file handed to the model as a native document block rather than as text.
 *
 * Exists because some inputs cannot be stringified into the JSON context: a
 * resume arrives as a PDF, and `pdf-lib` (the only PDF library in the runtime)
 * creates PDFs rather than extracting text from them. The model reads the file
 * directly instead, which is the route integrations/anthropic/score-resume.ts
 * already takes for resume scoring.
 */
export interface LlmDocument {
  /** Base64-encoded file bytes. */
  base64: string;
  /** Currently only "application/pdf" is accepted by the document block API. */
  mediaType: string;
}

/**
 * Build the user message content.
 *
 * Returns the bare prompt STRING when there are no documents, which is what this
 * did before documents existed. That matters: every orchestration in the registry
 * goes through here, so the no-document path has to produce exactly the request it
 * always did, not a one-element content array that merely behaves the same.
 */
function buildUserContent(
  prompt: string,
  documents?: LlmDocument[],
): string | Anthropic.ContentBlockParam[] {
  if (!documents || documents.length === 0) return prompt;
  return [
    ...documents.map((d) => ({
      type: "document" as const,
      source: {
        type: "base64" as const,
        media_type: d.mediaType as "application/pdf",
        data: d.base64,
      },
    })),
    // Text last so the instruction reads as being about the documents above it.
    { type: "text" as const, text: prompt },
  ];
}

export async function llm_extract<T extends z.ZodTypeAny>(
  ctx: RunContext,
  options: {
    name: string;
    prompt: string;
    input: unknown;
    schema: T;
    /** Files the model should read directly. Omit for the ordinary text path. */
    documents?: LlmDocument[];
    /**
     * Output cap. Defaults to 4096, which is right for a handful of fields but too
     * small for a long array: the response is cut mid-JSON and surfaces as a
     * ZodError with no hint that length was the cause. Raise it when the schema is
     * a list whose length scales with the input (beady/opportunity-sweep scores a
     * batch of notices and returns one entry per notice).
     */
    maxTokens?: number;
  },
): Promise<z.infer<T>> {
  const db = new SupabaseClient(ctx.env);
  const idx = ctx.stepIndex();
  const maxTokens = options.maxTokens ?? LLM_EXTRACT_DEFAULT_MAX_TOKENS;

  // Replay short-circuit
  const cached = await db.getCompletedStep(ctx.runId, idx);
  if (cached !== null) {
    return cached.output as z.infer<T>;
  }

  const runStep = await db.createRunStep({
    run_id: ctx.runId,
    step_index: idx,
    step_name: options.name,
    step_type: "llm_extract",
    status: "running",
    input: {
      prompt: options.prompt,
      context: options.input,
      // Metadata only. Persisting base64 here would put a multi-megabyte file in
      // run_steps.input and in every run detail view that reads it back.
      ...(options.documents?.length
        ? {
            documents: options.documents.map((d) => ({
              mediaType: d.mediaType,
              approxBytes: Math.round((d.base64.length * 3) / 4),
            })),
          }
        : {}),
    },
  });

  const userPrompt = `${options.prompt}\n\nContext:\n${JSON.stringify(options.input, null, 2)}`;
  const userContent = buildUserContent(userPrompt, options.documents);
  const toolSchema = zodToJsonSchema(options.schema);

  // In Workflow mode, wrap the LLM call in step.do() for durability + retry
  if (ctx.workflowStep) {
    try {
      const result = await ctx.workflowStep.do(`llm-extract-${idx}`, {
        retries: { limit: 2, delay: "10 seconds", backoff: "linear" },
      }, async () => {
        const client = makeClient(ctx);
        const response = await client.messages.create({
          model: resolveModel(ctx),
          max_tokens: maxTokens,
          tools: [
            {
              name: "extract",
              description: "Extract structured data from the provided context",
              input_schema: toolSchema as Anthropic.Tool["input_schema"],
            },
          ],
          tool_choice: { type: "tool", name: "extract" },
          messages: [{ role: "user", content: userContent }],
        });

        assertNotTruncated(response.stop_reason, options.name, maxTokens);

        const toolUse = response.content.find((b) => b.type === "tool_use");
        if (!toolUse || toolUse.type !== "tool_use") {
          throw new Error("Model did not call the extract tool");
        }

        const parsed = options.schema.parse(toolUse.input);
        return {
          parsed,
          raw: JSON.stringify(toolUse.input),
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        };
      });

      await db.updateRunStep(runStep.id, {
        status: "completed",
        output: result.parsed,
        llm_model: resolveModel(ctx),
        llm_prompt: options.prompt,
        llm_response: result.raw,
        llm_input_tokens: result.inputTokens,
        llm_output_tokens: result.outputTokens,
        ended_at: new Date().toISOString(),
      });
      return result.parsed as z.infer<T>;
    } catch (err) {
      await db.updateRunStep(runStep.id, {
        status: "failed",
        error: { message: err instanceof Error ? err.message : String(err) },
        ended_at: new Date().toISOString(),
      });
      throw err;
    }
  }

  try {
    const client = makeClient(ctx);

    const response = await client.messages.create({
      model: resolveModel(ctx),
      max_tokens: maxTokens,
      tools: [
        {
          name: "extract",
          description: "Extract structured data from the provided context",
          input_schema: toolSchema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: "extract" },
      messages: [{ role: "user", content: userContent }],
    });

    assertNotTruncated(response.stop_reason, options.name, maxTokens);

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Model did not call the extract tool");
    }

    const parsed = options.schema.parse(toolUse.input);

    await db.updateRunStep(runStep.id, {
      status: "completed",
      output: parsed,
      llm_model: resolveModel(ctx),
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
