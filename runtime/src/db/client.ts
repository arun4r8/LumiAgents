import type { Env, Run, RunStep, Schedule } from "../types";

// Minimal typed Supabase REST client — no Node deps, pure fetch.

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
      "/rest/v1/orchestration.runs",
      "POST",
      data,
    );
    const row = rows[0];
    if (!row) throw new Error("createRun returned no row");
    return row;
  }

  async updateRun(id: string, data: Partial<Run>): Promise<void> {
    await this.request(
      `/rest/v1/orchestration.runs?id=eq.${id}`,
      "PATCH",
      data,
    );
  }

  async getRun(id: string): Promise<Run> {
    const rows = await this.request<Run[]>(
      `/rest/v1/orchestration.runs?id=eq.${id}&limit=1`,
      "GET",
    );
    const row = rows[0];
    if (!row) throw new Error(`Run ${id} not found`);
    return row;
  }

  // ─── Run steps ────────────────────────────────────────────────────────────

  async createRunStep(data: Omit<RunStep, "id" | "started_at">): Promise<RunStep> {
    const rows = await this.request<RunStep[]>(
      "/rest/v1/orchestration.run_steps",
      "POST",
      data,
    );
    const row = rows[0];
    if (!row) throw new Error("createRunStep returned no row");
    return row;
  }

  async updateRunStep(id: string, data: Partial<RunStep>): Promise<void> {
    await this.request(
      `/rest/v1/orchestration.run_steps?id=eq.${id}`,
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
      "/rest/v1/orchestration.tool_calls",
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
      `/rest/v1/orchestration.tool_calls?id=eq.${id}`,
      "PATCH",
      { ...data, ended_at: new Date().toISOString() },
    );
  }

  // ─── Replay helpers ───────────────────────────────────────────────────────

  /** Returns the cached output of a completed step, or null if not yet run. */
  async getCompletedStep(runId: string, stepIndex: number): Promise<{ id: string; output: unknown } | null> {
    const rows = await this.request<{ id: string; output: unknown }[]>(
      `/rest/v1/orchestration.run_steps?run_id=eq.${runId}&step_index=eq.${stepIndex}&status=eq.completed&select=id,output&limit=1`,
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
      `/rest/v1/orchestration.approvals?run_step_id=eq.${runStepId}&select=id,status,decision_notes,decided_by&limit=1`,
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
      `/rest/v1/orchestration.approvals?id=eq.${approvalId}&select=id,run_id,run_step_id,status,decision_notes,decided_by&limit=1`,
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
      `/rest/v1/orchestration.approvals?id=eq.${approvalId}`,
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
  }> {
    const versionFilter = version ? `&version=eq.${version}` : "&order=version.desc&limit=1";
    const rows = await this.request<{ id: string; name: string; version: number; is_active: boolean }[]>(
      `/rest/v1/orchestration.orchestrations?name=eq.${encodeURIComponent(name)}${versionFilter}`,
      "GET",
    );
    const row = rows[0];
    if (!row) throw new Error(`Orchestration "${name}" not found`);
    return row;
  }

  // ─── Schedules ────────────────────────────────────────────────────────────

  async getActiveSchedules(): Promise<Schedule[]> {
    return this.request<Schedule[]>(
      "/rest/v1/orchestration.schedules?is_active=eq.true&select=id,orchestration_name,label,cron_expression,default_input,last_run_at",
      "GET",
    );
  }

  async touchSchedule(id: string, ranAt: string): Promise<void> {
    await this.request(
      `/rest/v1/orchestration.schedules?id=eq.${id}`,
      "PATCH",
      { last_run_at: ranAt, updated_at: ranAt },
    );
  }

  async listSchedules(): Promise<Schedule[]> {
    return this.request<Schedule[]>(
      "/rest/v1/orchestration.schedules?select=*&order=created_at.asc",
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
      "/rest/v1/orchestration.schedules",
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
      `/rest/v1/orchestration.schedules?id=eq.${id}`,
      "PATCH",
      { ...data, updated_at: new Date().toISOString() },
    );
  }

  async deactivateSchedule(id: string): Promise<void> {
    await this.request(
      `/rest/v1/orchestration.schedules?id=eq.${id}`,
      "PATCH",
      { is_active: false, updated_at: new Date().toISOString() },
    );
  }
}
