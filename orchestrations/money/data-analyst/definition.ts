import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { runDataAnalyst } from "@/runtime/agents/data-analyst";

export const inputSchema = z.object({
  question: z.string().min(1).describe("Natural language business question"),
  tables: z.array(z.string()).optional().describe("Restrict to specific tables (optional; defaults to all available)"),
  maxRows: z.number().int().min(1).max(5000).default(500).describe("Row cap for query results"),
});

export const outputSchema = z.object({
  answer: z.string(),
  sql: z.string().optional(),
  rowCount: z.number().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export default defineOrchestration({
  name: "money/data-analyst",
  version: 1,
  description: "Answer business questions by generating and running SQL against Lumiture's data, then interpreting the results",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops", "role:analyst"],
    visibleTo: ["role:ops", "role:analyst"],
  },
  async run(ctx, input) {
    return step(ctx, "generate-and-interpret", () =>
      runDataAnalyst(ctx.env, {
        question: input.question,
        ...(input.tables !== undefined ? { tables: input.tables } : {}),
        maxRows: input.maxRows,
      }),
    );
  },
});
