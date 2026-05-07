import type { Env, Run, RunStep } from "../types";

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
      body: body ? JSON.stringify(body) : undefined,
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
    run_step_id: string;
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
}
