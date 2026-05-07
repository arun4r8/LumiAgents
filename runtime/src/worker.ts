import type { Env, RunContext } from "./types";
import { createHandler, PauseSignal } from "./index";
import { ingestDocument, queryDocuments } from "./agents/document-rag";
import { runDataAnalyst } from "./agents/data-analyst";
import { SupabaseClient } from "./db/client";

// ─── Orchestration registry ───────────────────────────────────────────────────
// Import all orchestration definitions and register them by name.
// The name key MUST match the `name` field in the definition.

import angieResumeFormatting from "../../orchestrations/angie/resume-formatting/definition";
import angieResumeScreening from "../../orchestrations/angie/resume-screening/definition";
import angieCandidateSourcing from "../../orchestrations/angie/candidate-sourcing/definition";
import beadyGovconAssessment from "../../orchestrations/beady/govcon-assessment/definition";
import beadyOpportunitySearch from "../../orchestrations/beady/opportunity-search/definition";
import moneyDataAnalyst from "../../orchestrations/money/data-analyst";
import moneyFinancialReport from "../../orchestrations/money/financial-report/definition";
import patchInboundTriage from "../../orchestrations/patch/inbound-triage/definition";
import patchTicketOps from "../../orchestrations/patch/ticket-ops/definition";
import patchStaffRequest from "../../orchestrations/patch/staff-request/definition";
import * as patchDocumentRag from "../../orchestrations/patch/document-rag";

import { z } from "zod";
import type { OrchestrationDefinition } from "./types";

type AnyOrch = OrchestrationDefinition<z.ZodTypeAny, z.ZodTypeAny>;

function reg(o: AnyOrch): [string, AnyOrch] {
  return [o.name, o];
}

const orchestrations = new Map<string, AnyOrch>([
  reg(angieResumeFormatting  as unknown as AnyOrch),
  reg(angieResumeScreening   as unknown as AnyOrch),
  reg(angieCandidateSourcing as unknown as AnyOrch),
  reg(beadyGovconAssessment  as unknown as AnyOrch),
  reg(beadyOpportunitySearch as unknown as AnyOrch),
  reg(moneyDataAnalyst       as unknown as AnyOrch),
  reg(moneyFinancialReport   as unknown as AnyOrch),
  reg(patchInboundTriage     as unknown as AnyOrch),
  reg(patchTicketOps         as unknown as AnyOrch),
  reg(patchStaffRequest      as unknown as AnyOrch),
  reg(patchDocumentRag.documentIngest as unknown as AnyOrch),
  reg(patchDocumentRag.documentQuery  as unknown as AnyOrch),
]);

const orchHandler = createHandler(orchestrations);

// ─── Request helpers ──────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ─── Main Worker ──────────────────────────────────────────────────────────────

// ─── JWT auth helper ──────────────────────────────────────────────────────────
// Decodes the Supabase JWT (set by our custom_access_token_hook) to extract
// the user's role claim. No signature verification — internal use only;
// tokens are short-lived and forging requires the Supabase JWT secret.

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    const payload = parts[1];
    if (!payload) return null;
    const padded = payload.padEnd(payload.length + (4 - (payload.length % 4)) % 4, "=");
    const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function requireOpsToken(request: Request): { userId: string } | Response {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  const claims = decodeJwtClaims(auth.slice(7));
  if (!claims) {
    return new Response(JSON.stringify({ error: "Invalid token" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  if (claims["role"] !== "ops") {
    return new Response(JSON.stringify({ error: "Forbidden — ops role required" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    });
  }
  return { userId: claims["sub"] as string };
}

// ─── Cron dispatcher ──────────────────────────────────────────────────────────
// Finds every registered orchestration whose `cron` field matches the
// triggered cron expression and runs it with schema-defaulted input.

async function dispatchCron(cronExpr: string, env: Env): Promise<void> {
  const matching = Array.from(orchestrations.values()).filter(
    (o) => o.cron === cronExpr,
  );

  for (const orch of matching) {
    const inputResult = orch.inputSchema.safeParse({});
    if (!inputResult.success) {
      console.error(`[cron] ${orch.name}: default input failed validation`, inputResult.error);
      continue;
    }
    const input = inputResult.data;

    const db = new SupabaseClient(env);
    let orchRecord: Awaited<ReturnType<typeof db.getOrchestrationByName>>;
    try {
      orchRecord = await db.getOrchestrationByName(orch.name, orch.version);
    } catch (err) {
      console.error(`[cron] ${orch.name}: orchestration record not found in DB`, err);
      continue;
    }

    const run = await db.createRun({
      orchestration_id: orchRecord.id,
      orchestration_version: orch.version,
      status: "running",
      input,
      triggered_by: "cron",
      started_at: new Date().toISOString(),
    });

    let stepCounter = 0;
    const ctx: RunContext = {
      runId: run.id,
      stepIndex: () => stepCounter++,
      env,
      idempotencyKey: (tool, ...parts) => `${run.id}:${tool}:${parts.join(":")}`,
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    };

    try {
      const output = await orch.run(ctx, input);
      await db.updateRun(run.id, {
        status: "completed",
        output,
        ended_at: new Date().toISOString(),
      });
      console.log(`[cron] ${orch.name} completed (run ${run.id})`);
    } catch (err) {
      await db.updateRun(run.id, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        ended_at: new Date().toISOString(),
      });
      console.error(`[cron] ${orch.name} failed (run ${run.id}):`, err);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    try {
      // ── Orchestration runner: POST /api/orchestrations/:name/run ────────────
      if (pathname.startsWith("/api/orchestrations/")) {
        return orchHandler.fetch(request, env);
      }

      // ── Orchestration catalogue: GET /api/orchestrations ────────────────────
      if (pathname === "/api/orchestrations" && request.method === "GET") {
        const catalogue = Array.from(orchestrations.values()).map((o) => ({
          name: o.name,
          version: o.version,
          description: o.description ?? null,
          access: o.access,
          inputSchema: schemaToJsonSchema(o.inputSchema),
        }));
        return json(catalogue);
      }

      // ── Document RAG: ingest ────────────────────────────────────────────────
      if (pathname === "/api/documents/ingest" && request.method === "POST") {
        const body = await request.json() as {
          sourceName: string;
          sourceKind: "pdf" | "text" | "csv" | "url";
          content: string;
          storagePath?: string;
          metadata?: Record<string, unknown>;
        };

        if (!body.sourceName || !body.sourceKind || !body.content) {
          return json({ error: "sourceName, sourceKind, and content are required" }, 400);
        }

        const db = new SupabaseClient(env);
        const orchRecord = await db.getOrchestrationByName("document-ingest").catch(() => null);

        const run = orchRecord
          ? await db.createRun({
              orchestration_id: orchRecord.id,
              orchestration_version: 1,
              status: "running",
              input: body,
              triggered_by: "webhook",
              started_at: new Date().toISOString(),
            })
          : null;

        const result = await ingestDocument(env, body);

        if (run) {
          await db.updateRun(run.id, {
            status: "completed",
            output: result,
            ended_at: new Date().toISOString(),
          });
        }

        return json({ ...result, runId: run?.id });
      }

      // ── Document RAG: query ─────────────────────────────────────────────────
      if (pathname === "/api/documents/query" && request.method === "POST") {
        const body = await request.json() as {
          question: string;
          minSimilarity?: number;
          maxChunks?: number;
        };

        if (!body.question) {
          return json({ error: "question is required" }, 400);
        }

        const result = await queryDocuments(env, body);
        return json(result);
      }

      // ── Data Analyst ────────────────────────────────────────────────────────
      if (pathname === "/api/analyst/query" && request.method === "POST") {
        const body = await request.json() as {
          question: string;
          tables?: string[];
          maxRows?: number;
        };

        if (!body.question) {
          return json({ error: "question is required" }, 400);
        }

        const result = await runDataAnalyst(env, body);
        return json(result);
      }

      // ── Approval response: POST /api/approvals/:id/respond ──────────────────
      const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/respond$/);
      if (approvalMatch && request.method === "POST") {
        const approvalId = approvalMatch[1];
        if (!approvalId) return json({ error: "Missing approval ID" }, 400);

        const authResult = requireOpsToken(request);
        if (authResult instanceof Response) return authResult;
        const { userId: decidedByUserId } = authResult;

        let body: { approved: boolean; notes?: string };
        try {
          body = await request.json() as typeof body;
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }
        if (typeof body.approved !== "boolean") {
          return json({ error: "'approved' (boolean) is required" }, 422);
        }

        const db = new SupabaseClient(env);

        // Write the decision
        await db.respondToApproval(approvalId, {
          approved: body.approved,
          decidedBy: decidedByUserId,
          ...(body.notes !== undefined && { notes: body.notes }),
        });

        // Fetch the approval to get the run_id
        const approval = await db.getApproval(approvalId);
        const run = await db.getRun(approval.run_id);

        if (run.status !== "paused") {
          return json({ error: `Run ${run.id} is not paused (status: ${run.status})` }, 409);
        }

        // Look up the orchestration definition
        const orchRecord = await db.getOrchestrationByName(
          // name is stored on orchestration row; fetch it via the run
          await (async () => {
            const orchRows = await fetch(
              `${env.SUPABASE_URL}/rest/v1/orchestration.orchestrations?id=eq.${run.orchestration_id}&select=name&limit=1`,
              { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } },
            ).then((r) => r.json() as Promise<{ name: string }[]>);
            const name = orchRows[0]?.name;
            if (!name) throw new Error(`Orchestration ${run.orchestration_id} not found`);
            return name;
          })(),
        );

        const orch = orchestrations.get(orchRecord.name);
        if (!orch) return json({ error: `Orchestration "${orchRecord.name}" not registered` }, 404);

        const inputParsed = orch.inputSchema.safeParse(run.input);
        if (!inputParsed.success) return json({ error: "Stored run input failed schema validation" }, 500);

        // Mark running again before replay
        await db.updateRun(run.id, { status: "running" });

        let stepCounter = 0;
        const ctx: RunContext = {
          runId: run.id,
          stepIndex: () => stepCounter++,
          env,
          idempotencyKey: (tool, ...parts) => `${run.id}:${tool}:${parts.join(":")}`,
          fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
        };

        try {
          const output = await orch.run(ctx, inputParsed.data);
          await db.updateRun(run.id, {
            status: "completed",
            output,
            ended_at: new Date().toISOString(),
          });
          return json({ runId: run.id, status: "completed", output });
        } catch (err) {
          if (err instanceof PauseSignal) {
            await db.updateRun(run.id, { status: "paused" });
            return json({ runId: run.id, status: "paused", approvalId: err.approvalId }, 202);
          }
          await db.updateRun(run.id, {
            status: "failed",
            error: { message: err instanceof Error ? err.message : String(err) },
            ended_at: new Date().toISOString(),
          });
          return json(
            { runId: run.id, status: "failed", error: err instanceof Error ? err.message : String(err) },
            500,
          );
        }
      }

      // ── Health ──────────────────────────────────────────────────────────────
      if (pathname === "/health") {
        return json({
          status: "ok",
          environment: env.ENVIRONMENT,
          orchestrations: orchestrations.size,
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error("Worker error:", err);
      return json(
        { error: err instanceof Error ? err.message : "Internal server error" },
        500,
      );
    }
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await dispatchCron(controller.cron, env);
  },
} satisfies ExportedHandler<Env>;

// ─── Minimal Zod → JSON Schema for the catalogue endpoint ────────────────────

function schemaToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = schemaToJsonSchema(v);
      if (!(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault)) required.push(k);
    }
    return { type: "object", properties, required };
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray) return { type: "array", items: schemaToJsonSchema(schema.element) };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options as string[] };
  if (schema instanceof z.ZodOptional) return schemaToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return schemaToJsonSchema(schema._def.innerType as z.ZodTypeAny);
  if (schema instanceof z.ZodNullable) return { ...schemaToJsonSchema(schema.unwrap()), nullable: true };
  if (schema instanceof z.ZodDiscriminatedUnion) return { type: "object" };
  return {};
}
