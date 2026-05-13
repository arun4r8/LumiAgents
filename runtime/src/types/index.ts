import { z } from "zod";
import type { WorkflowStep } from "cloudflare:workers";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ANTHROPIC_API_KEY: string;
  N8N_WEBHOOK_SECRET?: string;  // optional — set when n8n webhooks have Header Auth configured
  APOLLO_API_KEY?: string;      // optional — set when Apollo API key is obtained
  JIRA_BASE_URL: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
  SAM_GOV_API_KEY: string;
  ENVIRONMENT: string;
  // CRM integration (Salesforce / HubSpot / Deltek Costpoint / …)
  CRM_API_URL?: string;
  CRM_API_KEY?: string;
  // HR integration (BambooHR / Workday / ADP / …)
  HR_API_URL?: string;
  HR_API_KEY?: string;
  // Accounting integration (QuickBooks / Unanet / Deltek Vision / …)
  ACCOUNTING_API_URL?: string;
  ACCOUNTING_API_KEY?: string;
  AI: Ai;  // Cloudflare Workers AI binding (used by document-rag for embeddings)
  /** Cloudflare Workflows binding — present in deployed Workers, absent in local dev without wrangler. */
  ORCHESTRATION_WORKFLOW: Workflow;
  // Teams integration (set via `wrangler secret put`)
  TEAMS_INCOMING_WEBHOOK_URL?: string;
  TEAMS_BOT_APP_ID?: string;
  TEAMS_BOT_APP_SECRET?: string;
  // GitHub integration — Obsidian vault sync (set via `wrangler secret put`)
  GITHUB_API_TOKEN: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

// ─── Run context passed to every step ────────────────────────────────────────

export interface RunContext {
  runId: string;
  stepIndex: () => number;
  env: Env;
  idempotencyKey: (tool: string, ...parts: string[]) => string;
  fetch: typeof fetch;
  /** Set when running inside a Cloudflare Workflow — enables durable step execution. */
  workflowStep?: WorkflowStep;
  /** ID of the currently-executing run_step row — set by step() before invoking fn(). */
  currentStepId?: string;
}

// ─── Orchestration definition ─────────────────────────────────────────────────

export interface OrchestrationDefinition<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
> {
  name: string;
  version: number;
  description?: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  cron?: string;
  access: {
    triggerableBy: string[];
    visibleTo: string[];
  };
  run: (ctx: RunContext, input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export interface ToolDefinition<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
> {
  name: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  run: (ctx: RunContext, input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
}

// ─── DB row types (mirrors orchestration schema) ──────────────────────────────

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type StepType = "step" | "llm_decide" | "llm_extract" | "await_approval" | "invoke";
export type StepStatus = "running" | "completed" | "failed" | "skipped";
export type TriggerSource = "user" | "cron" | "webhook" | "orchestration";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Run {
  id: string;
  orchestration_id: string;
  orchestration_version: number;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: unknown;
  triggered_by: TriggerSource;
  triggered_by_user_id?: string;
  triggered_by_run_id?: string;
  started_at?: string;
  ended_at?: string;
  created_at: string;
}

export interface Schedule {
  id: string;
  orchestration_name: string;
  label: string | null;
  cron_expression: string;
  is_active: boolean;
  default_input: Record<string, unknown>;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunStep {
  id: string;
  run_id: string;
  step_index: number;
  step_name: string;
  step_type: StepType;
  status: StepStatus;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  llm_model?: string;
  llm_prompt?: string;
  llm_response?: string;
  llm_input_tokens?: number;
  llm_output_tokens?: number;
  started_at: string;
  ended_at?: string;
}
