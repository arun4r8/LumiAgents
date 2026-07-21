import type { Env, Schedule } from "../types";
import { SupabaseClient } from "../db/client";
import { orchestrations } from "../registry";
import { json, requireOpsToken } from "./helpers";

export async function handleSchedules(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;

  // GET /api/schedules: list all schedules
  if (pathname === "/api/schedules" && request.method === "GET") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const db = new SupabaseClient(env);
    const rows = await db.listSchedules();
    return json(rows);
  }

  // POST /api/schedules: create a schedule
  if (pathname === "/api/schedules" && request.method === "POST") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const body = await request.json() as {
      orchestration_name: string;
      cron_expression: string;
      label?: string;
      default_input?: Record<string, unknown>;
    };

    if (!body.orchestration_name || !body.cron_expression) {
      return json({ error: "orchestration_name and cron_expression are required" }, 400);
    }
    if (!orchestrations.has(body.orchestration_name)) {
      return json({ error: `Orchestration "${body.orchestration_name}" not found in registry` }, 422);
    }

    const db = new SupabaseClient(env);
    const row = await db.createSchedule({
      orchestration_name: body.orchestration_name,
      cron_expression: body.cron_expression,
      label: body.label ?? null,
      default_input: body.default_input ?? {},
    });
    return json(row, 201);
  }

  // PATCH /api/schedules/:id: update label, cron, active flag, or default_input
  const scheduleMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleMatch && request.method === "PATCH") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const id = scheduleMatch[1]!;
    const body = await request.json() as Partial<Pick<Schedule,
      "label" | "cron_expression" | "is_active" | "default_input"
    >>;

    const db = new SupabaseClient(env);
    await db.updateSchedule(id, body);
    return json({ id, updated: true });
  }

  // DELETE /api/schedules/:id: deactivate (soft delete)
  if (scheduleMatch && request.method === "DELETE") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const id = scheduleMatch[1]!;
    const db = new SupabaseClient(env);
    await db.deactivateSchedule(id);
    return json({ id, deactivated: true });
  }

  return null;
}
