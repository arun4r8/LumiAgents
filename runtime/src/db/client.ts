import type { Env, Run, RunFailureAlert, RunStep, Schedule } from "../types";

// Minimal typed Supabase REST client: no Node deps, pure fetch.

export class SupabaseClient {
  private url: string;
  private key: string;

  constructor(env: Env) {
    this.url = env.SUPABASE_URL;
    this.key = env.SUPABASE_SERVICE_ROLE_KEY;
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      "apikey": this.key,
      "Authorization": `Bearer ${this.key}`,
      "Prefer": "return=representation",
      // PostgREST schema targeting: Content-Profile for mutations, Accept-Profile for reads.
      // Include both so all requests (GET and POST/PATCH) hit the orchestration schema.
      "Content-Profile": "orchestration",
      "Accept-Profile": "orchestration",
    };
  }

  private async request<T>(
    path: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { ...this.headers(), ...extraHeaders },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Supabase ${method} ${path} → ${res.status}: ${err}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : ([] as unknown as T);
  }

  // ─── Runs ──────────────────────────────────────────────────────────────────

  async createRun(data: Omit<Run, "id" | "created_at">): Promise<Run> {
    const rows = await this.request<Run[]>(
      "/rest/v1/runs",
      "POST",
      data,
    );
    const row = rows[0];
    if (!row) throw new Error("createRun returned no row");
    return row;
  }

  async updateRun(id: string, data: Partial<Run>): Promise<void> {
    await this.request(
      `/rest/v1/runs?id=eq.${id}`,
      "PATCH",
      data,
    );
  }

  async getRun(id: string): Promise<Run> {
    const rows = await this.request<Run[]>(
      `/rest/v1/runs?id=eq.${id}&limit=1`,
      "GET",
    );
    const row = rows[0];
    if (!row) throw new Error(`Run ${id} not found`);
    return row;
  }

  // Run history for the `list_recent_runs` chat tool. `prefix` (e.g. "beady/") is
  // validated by the caller (routes/runs.ts) against the known agent slugs — never
  // pass an unvalidated value here.
  async listRecentRuns(params: {
    prefix: string;
    sinceISO: string;
    limit: number;
  }): Promise<Array<{
    runId: string;
    orchestrationName: string;
    version: number;
    status: Run["status"];
    triggeredBy: Run["triggered_by"];
    createdAt: string;
    startedAt: string | undefined;
    endedAt: string | undefined;
  }>> {
    const qs = new URLSearchParams({
      select: "id,status,triggered_by,created_at,started_at,ended_at,orchestrations!inner(name,version)",
      "orchestrations.name": `like.${params.prefix}*`,
      created_at: `gte.${params.sinceISO}`,
      order: "created_at.desc",
      limit: String(params.limit),
    });
    const rows = await this.request<Array<{
      id: string;
      status: Run["status"];
      triggered_by: Run["triggered_by"];
      created_at: string;
      started_at?: string;
      ended_at?: string;
      orchestrations: { name: string; version: number };
    }>>(`/rest/v1/runs?${qs}`, "GET");

    return rows.map((r) => ({
      runId: r.id,
      orchestrationName: r.orchestrations.name,
      version: r.orchestrations.version,
      status: r.status,
      triggeredBy: r.triggered_by,
      createdAt: r.created_at,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }));
  }

  // ─── Run steps ────────────────────────────────────────────────────────────

  async createRunStep(data: Omit<RunStep, "id" | "started_at">): Promise<RunStep> {
    const rows = await this.request<RunStep[]>(
      "/rest/v1/run_steps",
      "POST",
      data,
    );
    const row = rows[0];
    if (!row) throw new Error("createRunStep returned no row");
    return row;
  }

  async updateRunStep(id: string, data: Partial<RunStep>): Promise<void> {
    await this.request(
      `/rest/v1/run_steps?id=eq.${id}`,
      "PATCH",
      data,
    );
  }

  // ─── Tool calls ───────────────────────────────────────────────────────────

  async createToolCall(data: {
    run_step_id?: string;
    tool_name: string;
    idempotency_key?: string;
    request?: unknown;
  }): Promise<{ id: string }> {
    const rows = await this.request<{ id: string }[]>(
      "/rest/v1/tool_calls",
      "POST",
      { ...data, status: "pending" },
    );
    const row = rows[0];
    if (!row) throw new Error("createToolCall returned no row");
    return row;
  }

  async updateToolCall(
    id: string,
    data: {
      response?: unknown;
      status: "success" | "failed";
      status_code?: number;
      latency_ms?: number;
    },
  ): Promise<void> {
    await this.request(
      `/rest/v1/tool_calls?id=eq.${id}`,
      "PATCH",
      { ...data, ended_at: new Date().toISOString() },
    );
  }

  // ─── Replay helpers ───────────────────────────────────────────────────────

  /** Returns the cached output of a completed step, or null if not yet run. */
  async getCompletedStep(runId: string, stepIndex: number): Promise<{ id: string; output: unknown } | null> {
    const rows = await this.request<{ id: string; output: unknown }[]>(
      `/rest/v1/run_steps?run_id=eq.${runId}&step_index=eq.${stepIndex}&status=eq.completed&select=id,output&limit=1`,
      "GET",
    );
    return rows[0] ?? null;
  }

  // ─── Approval helpers ─────────────────────────────────────────────────────

  async getApprovalByRunStep(runStepId: string): Promise<{
    id: string;
    status: string;
    decision_notes: string | null;
    decided_by: string | null;
  } | null> {
    const rows = await this.request<{
      id: string;
      status: string;
      decision_notes: string | null;
      decided_by: string | null;
    }[]>(
      `/rest/v1/approvals?run_step_id=eq.${runStepId}&select=id,status,decision_notes,decided_by&limit=1`,
      "GET",
    );
    return rows[0] ?? null;
  }

  async getApproval(approvalId: string): Promise<{
    id: string;
    run_id: string;
    run_step_id: string;
    status: string;
    decision_notes: string | null;
    decided_by: string | null;
  }> {
    const rows = await this.request<{
      id: string;
      run_id: string;
      run_step_id: string;
      status: string;
      decision_notes: string | null;
      decided_by: string | null;
    }[]>(
      `/rest/v1/approvals?id=eq.${approvalId}&select=id,run_id,run_step_id,status,decision_notes,decided_by&limit=1`,
      "GET",
    );
    const row = rows[0];
    if (!row) throw new Error(`Approval ${approvalId} not found`);
    return row;
  }

  async respondToApproval(
    approvalId: string,
    decision: { approved: boolean; notes?: string; decidedBy?: string },
  ): Promise<void> {
    await this.request(
      `/rest/v1/approvals?id=eq.${approvalId}`,
      "PATCH",
      {
        status: decision.approved ? "approved" : "rejected",
        decision_notes: decision.notes ?? null,
        decided_by: decision.decidedBy ?? null,
        decided_at: new Date().toISOString(),
      },
    );
  }

  // ─── Orchestration lookup ─────────────────────────────────────────────────

  async getOrchestrationByName(name: string, version?: number): Promise<{
    id: string;
    name: string;
    version: number;
    is_active: boolean;
    model: string | null;
  }> {
    const versionFilter = version ? `&version=eq.${version}` : "&order=version.desc&limit=1";
    const rows = await this.request<{ id: string; name: string; version: number; is_active: boolean; model: string | null }[]>(
      `/rest/v1/orchestrations?name=eq.${encodeURIComponent(name)}${versionFilter}&select=id,name,version,is_active,model`,
      "GET",
    );
    const row = rows[0];
    if (!row) throw new Error(`Orchestration "${name}" not found`);
    return row;
  }

  // ─── Agent config ─────────────────────────────────────────────────────────

  async getAgentConfig(agentId: string): Promise<{
    agent_id: string;
    model: string;
    max_tokens: number;
    notes: string | null;
  }> {
    const rows = await this.request<{ agent_id: string; model: string; max_tokens: number; notes: string | null }[]>(
      `/rest/v1/agent_configs?agent_id=eq.${encodeURIComponent(agentId)}&limit=1`,
      "GET",
    );
    const row = rows[0];
    if (!row) throw new Error(`Agent config for "${agentId}" not found`);
    return row;
  }

  // ─── Agent config overrides (Tier 0 customization) ─────────────────────────

  /**
   * Latest persona / card / enabled-tools override for an agent, or null when the
   * agent has never been customized. `agent_config_overrides` is append-only and
   * versioned, so the active override is simply the most-recent row per agent_id.
   * The chat loop layers this on top of the agent's code-defined systemPrompt/tools.
   */
  async getAgentOverrides(agentId: string): Promise<{
    id: string;
    agent_id: string;
    system_prompt: string | null;
    prompt_strategy: "append" | "replace";
    card: unknown | null;
    enabled_tools: string[] | null;
    updated_by: string | null;
    created_at: string;
  } | null> {
    const rows = await this.request<Array<{
      id: string;
      agent_id: string;
      system_prompt: string | null;
      prompt_strategy: "append" | "replace";
      card: unknown | null;
      enabled_tools: string[] | null;
      updated_by: string | null;
      created_at: string;
    }>>(
      `/rest/v1/agent_config_overrides?agent_id=eq.${encodeURIComponent(agentId)}&order=created_at.desc&limit=1`,
      "GET",
    );
    return rows[0] ?? null;
  }

  // ─── Run failure alert state ──────────────────────────────────────────────

  /** Current failure streak for an orchestration, or null when it is healthy. */
  async getRunFailureAlert(orchestrationName: string): Promise<RunFailureAlert | null> {
    const rows = await this.request<RunFailureAlert[]>(
      `/rest/v1/run_failure_alerts?orchestration_name=eq.${encodeURIComponent(orchestrationName)}&limit=1`,
      "GET",
    );
    return rows[0] ?? null;
  }

  async upsertRunFailureAlert(data: RunFailureAlert): Promise<void> {
    await this.request(
      "/rest/v1/run_failure_alerts",
      "POST",
      { ...data, updated_at: new Date().toISOString() },
      { Prefer: "resolution=merge-duplicates,return=minimal" },
    );
  }

  /**
   * Clears the streak and returns the row that was cleared (null if there was none).
   * A delete-returning keeps the success path to a single round trip: the caller only
   * learns "this orchestration was previously failing" if there was something to clear.
   */
  async clearRunFailureAlert(orchestrationName: string): Promise<RunFailureAlert | null> {
    const rows = await this.request<RunFailureAlert[]>(
      `/rest/v1/run_failure_alerts?orchestration_name=eq.${encodeURIComponent(orchestrationName)}`,
      "DELETE",
    );
    return rows[0] ?? null;
  }

  // ─── Schedules ────────────────────────────────────────────────────────────

  async getActiveSchedules(): Promise<Schedule[]> {
    return this.request<Schedule[]>(
      "/rest/v1/schedules?is_active=eq.true&select=id,orchestration_name,label,cron_expression,default_input,last_run_at",
      "GET",
    );
  }

  async touchSchedule(id: string, ranAt: string): Promise<void> {
    await this.request(
      `/rest/v1/schedules?id=eq.${id}`,
      "PATCH",
      { last_run_at: ranAt, updated_at: ranAt },
    );
  }

  async listSchedules(): Promise<Schedule[]> {
    return this.request<Schedule[]>(
      "/rest/v1/schedules?select=*&order=created_at.asc",
      "GET",
    );
  }

  async createSchedule(data: {
    orchestration_name: string;
    cron_expression: string;
    label?: string | null;
    default_input?: Record<string, unknown>;
  }): Promise<Schedule> {
    const rows = await this.request<Schedule[]>(
      "/rest/v1/schedules",
      "POST",
      {
        orchestration_name: data.orchestration_name,
        cron_expression: data.cron_expression,
        label: data.label ?? null,
        default_input: data.default_input ?? {},
        is_active: true,
      },
    );
    const row = rows[0];
    if (!row) throw new Error("createSchedule returned no row");
    return row;
  }

  async updateSchedule(id: string, data: Partial<Pick<Schedule, "label" | "cron_expression" | "is_active" | "default_input">>): Promise<void> {
    await this.request(
      `/rest/v1/schedules?id=eq.${id}`,
      "PATCH",
      { ...data, updated_at: new Date().toISOString() },
    );
  }

  async deactivateSchedule(id: string): Promise<void> {
    await this.request(
      `/rest/v1/schedules?id=eq.${id}`,
      "PATCH",
      { is_active: false, updated_at: new Date().toISOString() },
    );
  }
}
