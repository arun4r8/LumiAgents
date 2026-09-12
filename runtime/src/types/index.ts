import { z } from "zod";
import type { KnowledgeScope } from "../agents/knowledge-access";
import type { WorkflowStep } from "cloudflare:workers";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWT_SECRET: string;
  ANTHROPIC_API_KEY: string;
  N8N_WEBHOOK_SECRET?: string;  // optional: set when n8n webhooks have Header Auth configured
  N8N_QUEUE_ENABLED?: string;   // gate for the n8n call-queue drainer; disabled unless === "true"
  APOLLO_API_KEY?: string;      // optional: set when Apollo API key is obtained
  JIRA_BASE_URL: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
  SAM_GOV_API_KEY: string;
  // Override for the DoD SBIR/STTR topics API base. The portal moved from
  // dodsbirsttr.mil → www.defensesbirsttr.mil; this lets us re-point without a redeploy
  // if the endpoint shifts again. Unset → the built-in default is used.
  SBIR_API_BASE?: string;
  // Comma-separated recipients for operational failure alerts (sweep health,
  // content-calendar nudge). Sent via Resend. Unset → alerts are logged, not emailed.
  ALERT_EMAIL?: string;
  ENVIRONMENT: string;
  // Comma-separated CORS allowlist (dashboard origin). Unset → CORS stays "*".
  ALLOWED_ORIGINS?: string;
  AI: Ai;  // Cloudflare Workers AI binding (used by document-rag for embeddings)
  /** Cloudflare Workflows binding: present in deployed Workers, absent in local dev without wrangler. */
  ORCHESTRATION_WORKFLOW: Workflow;
  // Per-agent Service Bindings: present in production, absent in local dev (fallback to local fn).
  ANGIE_WORKER?: Fetcher;
  BEADY_WORKER?: Fetcher;
  CLEO_WORKER?: Fetcher;
  DEWEY_WORKER?: Fetcher;
  PATCH_WORKER?: Fetcher;
  MONEY_WORKER?: Fetcher;
  // GitHub integration (Obsidian vault sync)
  VAULT_OWNER: string;           // set in wrangler.toml [vars]; org/user that owns LumiKnowledge
  VAULT_REPO: string;            // set in wrangler.toml [vars]
  GITHUB_API_TOKEN: string;      // set via `wrangler secret put`
  GITHUB_WEBHOOK_SECRET?: string;
  // ── Tier 2 agent builder (#67): GitHub App credential for opening code PRs ──────
  // A dedicated GitHub App installed on LumitureLabs/LumiAgents with Contents:write +
  // Pull requests:write and NOTHING else (no merge, no admin). Chosen over a PAT for a
  // stable, installation-scoped identity. The runtime mints a short-lived RS256 JWT from
  // the App key and exchanges it for an installation token (see integrations/github/app-auth.ts).
  // ALL THREE are provisioned OUT-OF-BAND by ops (wrangler secret put) and are ABSENT in CI;
  // every code path that needs them guards on their presence so their absence never breaks
  // the build or unrelated routes. Never reuse GITHUB_API_TOKEN (that is the read-only vault
  // credential scoped to a different repo).
  GH_APP_ID?: string;                 // the GitHub App's numeric app id (JWT `iss`)
  GH_APP_INSTALLATION_ID?: string;    // the installation id on LumitureLabs/LumiAgents
  GH_APP_PRIVATE_KEY?: string;        // base64 of the App's PKCS8 PEM private key
  // Tavily web-search (GovCon incumbent research), set via `wrangler secret put`
  TAVILY_API_KEY?: string;
  // Resend transactional email (opportunity report dispatch), set via `wrangler secret put`
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;  // e.g. "Beady <reports@lumiture.com>"
  // Microsoft Graph app-only creds (client-credentials), set via `wrangler secret put`.
  // Used to live-sync the content calendar from the M365 planning workbook.
  MSGRAPH_TENANT_ID?: string;
  MSGRAPH_CLIENT_ID?: string;
  MSGRAPH_CLIENT_SECRET?: string;
  // Location of the content-calendar planning workbook in Microsoft 365 (Graph
  // drive + item IDs; optional worksheet name → defaults to the first sheet).
  // Set in wrangler.toml [vars]. Unset → the Graph content sync is disabled.
  CONTENT_CALENDAR_DRIVE_ID?: string;
  /** Graph drive hosting the Lumiture Labs document library, for per-project BD folders (#207). */
  BD_DRIVE_ID?: string;
  /**
   * Graph drive hosting the BD site's document library, where BD keeps the GovWin
   * exports (#198). A DIFFERENT drive to BD_DRIVE_ID: the exports live on the BD
   * site, the project folders on Lumiture Labs.
   */
  GOVWIN_DRIVE_ID?: string;
  CONTENT_CALENDAR_ITEM_ID?: string;
  CONTENT_CALENDAR_WORKSHEET?: string;
  // Name of the Excel Table the two-way sync reads/writes (default "ContentCalendar").
  CONTENT_CALENDAR_TABLE?: string;
}

// ─── Run context passed to every step ────────────────────────────────────────

export interface RunContext {
  runId: string;
  stepIndex: () => number;
  env: Env;
  idempotencyKey: (tool: string, ...parts: string[]) => string;
  fetch: typeof fetch;
  /** Set when running inside a Cloudflare Workflow; enables durable step execution. */
  workflowStep?: WorkflowStep;
  /** ID of the currently-executing run_step row, set by step() before invoking fn(). */
  currentStepId?: string;
  /** LLM model resolved at run start from orchestration.agent_configs (with per-orchestration
   *  override). Falls back to claude-sonnet-4-6. llm_decide / llm_extract read this automatically. */
  model: string;
  /**
   * Read scope of the AGENT THAT INITIATED this run, when one did (#177).
   *
   * Retrieval orchestrations historically called `scopeForAgent("<their own slug>")`,
   * so a config agent that wired `dewey/knowledge-search` read dewey's private corpus
   * no matter what its own `knowledge_corpora` declared. This carries the caller's
   * scope so the orchestration can retrieve as its CALLER rather than as its author.
   *
   * Derived server-side in routes/orchestrations.ts from the `agent_slug` claim on the
   * dispatch token — never from the request body. It can only ever NARROW retrieval:
   * `scopeForConfigAgent` intersects the declaration with `allowedCorporaFor(slug)`.
   *
   * Undefined for a direct (non-agent) run, where the orchestration's own scope applies.
   */
  knowledgeScope?: KnowledgeScope;
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
  triggerMode?: "manual" | "agent";
  /**
   * Explicit declaration that `run()` performs NO writes (no INSERT/UPDATE/DELETE to
   * business data, no outbound email/Jira side effect) and contains NO
   * `await_approval`. Bookkeeping the framework itself does — run/run_step rows, LLM
   * usage — does not count.
   *
   * Only `readOnly: true` orchestrations may execute on the synchronous inline path
   * (`POST /api/orchestrations/:name/run-sync`), which has no durable execution and can
   * retry a step up to 4x in-process (primitives/step.ts) — harmless for a read, a
   * duplicate side effect for a write. It is also the single signal the config-agent
   * validator uses to decide whether a tool may be wired `mode: "sync"` (#127).
   *
   * Absent/false is the safe default: the orchestration is async-only.
   */
  readOnly?: boolean;
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

/**
 * One row per orchestration that is currently failing: the streak plus the
 * suppression state that stops a broken daily cron emailing every single run.
 * Deleted as soon as the orchestration succeeds again.
 */
export interface RunFailureAlert {
  orchestration_name: string;
  error_fingerprint: string;
  last_error: string | null;
  consecutive_failures: number;
  last_failed_run_id: string | null;
  first_failed_at: string;
  last_failed_at: string;
  last_alerted_at: string | null;
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
