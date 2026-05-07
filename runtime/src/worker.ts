import type { Env } from "./types";
import { createHandler } from "./index";
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
