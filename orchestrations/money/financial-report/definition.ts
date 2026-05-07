import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import { runDataAnalyst } from "@/runtime/agents/data-analyst";

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const inputSchema = z.object({
  reportType: z
    .enum(["burn-rate", "utilization", "invoices", "full"])
    .default("full")
    .describe("Which financial view to generate"),
  contractId: z
    .string()
    .uuid()
    .optional()
    .describe("Scope report to a single contract — omit for all active contracts"),
  fiscalYear: z
    .number()
    .int()
    .min(2020)
    .max(2030)
    .optional()
    .describe("Fiscal year to report on — defaults to current year"),
});

export const outputSchema = z.object({
  reportType: z.string(),
  generatedAt: z.string(),
  summary: z.string().describe("2-4 sentence executive summary"),
  metrics: z.record(z.unknown()).describe("Key-value financial metrics extracted"),
  narrative: z.string().describe("Full narrative report in markdown"),
  alerts: z.array(z.string()).describe("Anything that needs immediate attention"),
});

// ─── Question sets by report type ────────────────────────────────────────────

const QUESTIONS: Record<string, string[]> = {
  "burn-rate": [
    "What is the total budgeted, obligated, and expended amount across all active contracts? Break down by contract.",
    "Which contracts have expended more than 80% of their budget?",
    "What is the monthly burn rate for each active contract over the last 3 months?",
  ],
  utilization: [
    "What is the total labor hours charged per contract this fiscal year?",
    "Which employees have the highest and lowest utilization rates?",
    "Are there any contracts where labor charges exceed the budgeted labor hours?",
  ],
  invoices: [
    "How many invoices are outstanding (not yet paid)? What is the total outstanding amount?",
    "Which invoices are more than 30 days past due?",
    "What is the total invoiced amount vs total received this fiscal year?",
  ],
  full: [
    "What is the total budgeted, obligated, and expended amount across all active contracts?",
    "Which contracts have expended more than 80% of their budget?",
    "How many invoices are outstanding and what is the total outstanding amount?",
    "What is the overall labor utilization rate across all contracts?",
    "Are there any contracts at financial risk (over-budget, late invoices, low burn)?",
  ],
};

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "money/financial-report",
  version: 1,
  description:
    "Query Lumiture's financial data (contracts, budget lines, invoices, labor) and produce an executive financial report",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input) {
    const questions = QUESTIONS[input.reportType] ?? QUESTIONS["full"]!;
    const fy = input.fiscalYear ?? new Date().getFullYear();

    // Step 1: Run each financial question through the data analyst
    const queryResults = await step(ctx, "run-financial-queries", async () => {
      const results: Array<{ question: string; answer: string; sql?: string }> = [];

      for (const question of questions) {
        const scopedQuestion = input.contractId
          ? `${question} (scope: contract ID ${input.contractId}, fiscal year ${fy})`
          : `${question} (fiscal year ${fy})`;

        const result = await runDataAnalyst(ctx.env, {
          question: scopedQuestion,
          tables: ["contracts", "budget_lines", "invoices", "labor_records", "indirect_rates"],
          maxRows: 200,
        });

        results.push({
          question,
          answer: result.answer,
          ...(result.sql !== undefined ? { sql: result.sql } : {}),
        });
      }

      return results;
    });

    // Step 2: Synthesise into an executive report
    const report = await llm_extract(ctx, {
      name: "synthesise-financial-report",
      prompt: `
You are Money, Lumiture's financial AI. Synthesise the query results below into an
executive financial report for a government contracting firm.

Output format:
- summary: 2-4 sentences, suitable for a CEO briefing
- metrics: key numbers extracted (burn %, outstanding invoices $, utilization %)
- narrative: full markdown report with sections for each analysis area
- alerts: a bulleted list of anything requiring immediate attention
  (e.g. contract > 90% burned, invoice 60+ days overdue, labour over budget)
      `.trim(),
      input: {
        reportType: input.reportType,
        fiscalYear: fy,
        contractScope: input.contractId ?? "all active contracts",
        queryResults,
      },
      schema: z.object({
        summary: z.string(),
        metrics: z.record(z.unknown()),
        narrative: z.string(),
        alerts: z.array(z.string()),
      }),
    });

    return {
      reportType: input.reportType,
      generatedAt: new Date().toISOString(),
      summary: report.summary,
      metrics: report.metrics,
      narrative: report.narrative,
      alerts: report.alerts,
    };
  },
});
