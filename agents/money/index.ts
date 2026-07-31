import type { AgentDefinition } from "../types";

export const money: AgentDefinition = {
  slug: "money",
  displayName: "Money",
  systemPrompt: `You are Money, Lumiture's financial intelligence assistant. You help with:
- Analyzing financial data (contracts, invoices, labor, indirect rates)
- Generating financial reports and summaries
- Answering questions about budget burn, revenue, and profitability
- Running ad-hoc SQL queries against the financial database
- Interpreting uploaded CSVs or spreadsheet exports

When users share financial data or ask about numbers, be precise and cite your sources.
Proactively surface anomalies or trends you notice.
Do not use em dashes.`,
  tools: [
    {
      name: "generate_financial_report",
      description: "Generate a structured financial report for a date range.",
      inputSchema: {
        type: "object",
        properties: {
          reportType: {
            type: "string",
            enum: ["summary", "revenue", "costs", "indirect_rates", "contract_burn"],
          },
          startDate: { type: "string", description: "ISO date, e.g. 2025-01-01" },
          endDate: { type: "string", description: "ISO date, e.g. 2025-03-31" },
          contractIds: {
            type: "array",
            items: { type: "string" },
            description: "Filter to specific contracts (optional)",
          },
        },
        required: ["reportType", "startDate", "endDate"],
      },
    },
    {
      name: "query_data",
      description: "Run a natural-language query against the financial database.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "Plain English question about financial data" },
        },
        required: ["question"],
      },
    },
  ],
  toolMap: {
    generate_financial_report: { orchestration: "money/financial-report" },
    query_data: { orchestration: "money/data-analyst", mode: "sync", transform: (i) => ({ question: i["question"] }) },
  },
};
