import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../types";

const MODEL = "claude-sonnet-4-6";

// Tables the analyst can query: a curated list to keep the schema prompt focused.
// Add tables here as the business needs grow.
const QUERYABLE_TABLES = [
  "public.opportunities",
  "public.assessments",
  "public.contracts",
  "public.budget_lines",
  "public.invoices",
  "public.labor_records",
  "public.indirect_rates",
  "public.employees",
  "public.candidates",
  "public.resume_results",
  "public.resume_jobs",
  "public.past_performance",
] as const;

// Compact schema descriptions, which keep the prompt tight.
// These are hand-maintained and should match the real schema.
const TABLE_SCHEMAS: Record<string, string> = {
  "public.opportunities": `opportunities(id uuid, title text, agency text, set_aside text, naics_code text, solicitation_number text, response_deadline date, posted_date date, source text, source_url text, status text, fit_score float, fit_reason text, red_flags text, recommendation text, last_scored_at timestamptz, created_at timestamptz)`,

  "public.assessments": `assessments(id uuid, opportunity_id uuid FK→opportunities, company_profile_id uuid, dimension_scores jsonb, weights jsonb, weighted_score float, go_no_go text, result jsonb, executive_memo text, created_at timestamptz)`,

  "public.contracts": `contracts(id uuid, contract_number text, task_order_number text, vehicle text, client_name text, client_agency text, contract_type text, set_aside text, total_value numeric, obligated_value numeric, option_years int, pop_start date, pop_end date, status text, opportunity_id uuid FK→opportunities, created_at timestamptz, updated_at timestamptz)`,

  "public.budget_lines": `budget_lines(id uuid, contract_id uuid FK→contracts, clin text, description text, category text, fiscal_year int, budgeted numeric, obligated numeric, expended numeric, remaining numeric, notes text, created_at timestamptz)`,

  "public.invoices": `invoices(id uuid, contract_id uuid FK→contracts, client_name text, client_agency text, amount numeric, amount_paid numeric, invoice_date date, due_date date, paid_date date, status text, billing_period text, line_items jsonb, created_at timestamptz)`,

  "public.labor_records": `labor_records(id uuid, employee_id uuid FK→employees, employee_name text, contract_id uuid FK→contracts, contract_number text, clin text, work_date date, hours numeric, labor_category text, hourly_rate numeric, charge_type text, approved_at timestamptz, created_at timestamptz)`,

  "public.indirect_rates": `indirect_rates(id uuid, fiscal_year int, rate_type text, rate_basis text, rate_pct numeric, approved_date date, effective_from date, effective_to date, created_at timestamptz)`,

  "public.employees": `employees(id uuid, full_name text, email text, title text, department text, start_date date, end_date date, status text, employment_type text, clearance_level text, manager_id uuid FK→employees, created_at timestamptz)`,

  "public.candidates": `candidates(id bigint, name text, email text, linkedin_url text, status text, role text, date_contacted timestamptz, resume_received timestamptz, created_at timestamptz)`,

  "public.resume_results": `resume_results(id uuid, job_id uuid FK→resume_jobs, name text, email text, role text, technical_skills_score int, work_experience_score int, academics_score int, projects_and_research_score int, leadership_and_initiative_score int, overall_score int, rationale text, status text, created_at timestamptz)`,

  "public.resume_jobs": `resume_jobs(id uuid, job text, status text, total int, processed int, created_at timestamptz)`,

  "public.past_performance": `past_performance(id uuid, company_profile_id uuid, title text, customer text, domain text, scope_summary text, contract_value text, period_of_performance text, relevance_tags jsonb, created_at timestamptz)`,

};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnalystRequest {
  question: string;
  tables?: string[];             // optional: restrict which tables to expose
  maxRows?: number;              // default 500, max 5000
  sessionKey?: string;           // if set, include uploaded CSV data for this session
}

export interface AnalystResult {
  answer: string;
  sql?: string;                  // the query that was run
  rowCount?: number;
  uploadedTables?: string[];     // names of any CSV uploads included in context
  inputTokens: number;
  outputTokens: number;
}

export interface CsvUploadRequest {
  sessionKey: string;
  sourceName: string;
  rows: Record<string, string>[];  // parsed CSV rows, max 5000
  colNames: string[];
}

export interface CsvUploadResult {
  sessionKey: string;
  sourceName: string;
  rowCount: number;
  colNames: string[];
}

// ─── CSV upload helpers ───────────────────────────────────────────────────────

export async function storeCsvUpload(env: Env, req: CsvUploadRequest): Promise<CsvUploadResult> {
  const MAX_ROWS = 5000;
  const rows = req.rows.slice(0, MAX_ROWS);

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/analyst_uploads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      session_key: req.sessionKey,
      source_name: req.sourceName,
      row_count: rows.length,
      col_names: req.colNames,
      data: rows,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to store CSV upload: ${await res.text()}`);
  }

  return {
    sessionKey: req.sessionKey,
    sourceName: req.sourceName,
    rowCount: rows.length,
    colNames: req.colNames,
  };
}

async function getSessionUploads(env: Env, sessionKey: string): Promise<Array<{
  source_name: string;
  col_names: string[];
  row_count: number;
}>> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/analyst_uploads?session_key=eq.${encodeURIComponent(sessionKey)}&select=source_name,col_names,row_count&expires_at=gt.${new Date().toISOString()}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );

  if (!res.ok) return [];
  const data = await res.json() as Array<{ source_name: string; col_names: string[]; row_count: number }>;
  return Array.isArray(data) ? data : [];
}

// ─── Supabase RPC helper ──────────────────────────────────────────────────────

async function runAnalystQuery(env: Env, sql: string): Promise<unknown[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/analyst_query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Profile": "orchestration",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ query_sql: sql }),
  });

  if (!res.ok) {
    throw new Error(`Query failed: ${await res.text()}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ─── Main analyst function ────────────────────────────────────────────────────

export async function runDataAnalyst(env: Env, req: AnalystRequest): Promise<AnalystResult> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const allowedTables = req.tables
    ? QUERYABLE_TABLES.filter((t) => req.tables!.includes(t))
    : QUERYABLE_TABLES;

  const maxRows = Math.min(req.maxRows ?? 500, 5000);

  // Load any CSV uploads for this session
  const sessionUploads = req.sessionKey
    ? await getSessionUploads(env, req.sessionKey)
    : [];

  // Build schema context: curated tables + uploaded CSVs
  const tableSchemas = allowedTables.map((t) => TABLE_SCHEMAS[t] ?? t).join("\n");

  const uploadSchemas = sessionUploads.map((u) => {
    const cols = u.col_names.map((c) => `${c} text`).join(", ");
    return `-- Uploaded CSV: "${u.source_name}" (${u.row_count} rows)\n` +
      `-- Query with: SELECT elem->>'colname' FROM public.analyst_uploads, jsonb_array_elements(data) AS elem WHERE session_key = '${req.sessionKey}' AND source_name = '${u.source_name}'\n` +
      `uploaded_csv_${u.source_name.replace(/[^a-z0-9]/gi, "_").toLowerCase()}(${cols})`;
  }).join("\n");

  const schemaContext = [tableSchemas, uploadSchemas].filter(Boolean).join("\n\n");

  // Phase 1: Generate SQL
  const uploadTableNote = sessionUploads.length > 0
    ? `\n\nFor uploaded CSVs, query via: SELECT elem->>'column' FROM public.analyst_uploads, jsonb_array_elements(data) AS elem WHERE session_key = '${req.sessionKey}' AND source_name = 'filename'. Cast numerics with (elem->>'col')::numeric.`
    : "";

  const sqlResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: `You are an expert PostgreSQL analyst for Lumiture, a government contracting firm.
Given a business question, write a single valid SELECT query to answer it.

Rules:
- Only use tables from the schema provided
- Only SELECT queries: no INSERT, UPDATE, DELETE, DROP, or any mutation
- Use proper joins where needed. Prefer explicit column names over SELECT *
- Limit results to ${maxRows} rows unless aggregating
- For financial amounts, round to 2 decimal places
- Return ONLY the SQL query, nothing else: no markdown, no explanation
- Do not use em dashes.${uploadTableNote}`,
    messages: [
      {
        role: "user",
        content: `Schema:\n${schemaContext}\n\nQuestion: ${req.question}`,
      },
    ],
  });

  const sqlInputTokens = sqlResponse.usage.input_tokens;
  const sqlOutputTokens = sqlResponse.usage.output_tokens;

  const rawSql = sqlResponse.content[0]?.type === "text"
    ? sqlResponse.content[0].text.trim().replace(/^```sql?\n?/, "").replace(/```$/, "").trim()
    : "";

  if (!rawSql.toUpperCase().startsWith("SELECT")) {
    return {
      answer: "I could not generate a valid SELECT query for that question. Please rephrase or check that the relevant data exists.",
      inputTokens: sqlInputTokens,
      outputTokens: sqlOutputTokens,
    };
  }

  // Phase 2: Execute the query
  let rows: unknown[];
  try {
    rows = await runAnalystQuery(env, rawSql);
  } catch (err) {
    // If query fails, let Claude try to explain the error
    return {
      answer: `The generated query failed to execute: ${err instanceof Error ? err.message : String(err)}\n\nGenerated SQL:\n\`\`\`sql\n${rawSql}\n\`\`\``,
      sql: rawSql,
      inputTokens: sqlInputTokens,
      outputTokens: sqlOutputTokens,
    };
  }

  // Phase 3: Interpret results
  const rowPreview = JSON.stringify(rows.slice(0, 100), null, 2);
  const truncated = rows.length > 100;

  const interpretResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: `You are a senior business analyst for Lumiture, a government contracting firm.
Interpret SQL query results and provide a clear, concise business answer.
Include key numbers, trends, or anomalies. Be direct and skip the filler.
If the result set is empty, say so and suggest why.
Do not use em dashes.`,
    messages: [
      {
        role: "user",
        content: `Question: ${req.question}

SQL used:
\`\`\`sql
${rawSql}
\`\`\`

Results (${rows.length} rows${truncated ? ", showing first 100" : ""}):
${rowPreview}`,
      },
    ],
  });

  const answer = interpretResponse.content[0]?.type === "text"
    ? interpretResponse.content[0].text
    : "";

  return {
    answer,
    sql: rawSql,
    rowCount: rows.length,
    uploadedTables: sessionUploads.map((u) => u.source_name),
    inputTokens: sqlInputTokens + interpretResponse.usage.input_tokens,
    outputTokens: sqlOutputTokens + interpretResponse.usage.output_tokens,
  };
}
