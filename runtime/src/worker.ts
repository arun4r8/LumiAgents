import { z } from "zod";
import type { Env } from "./types";
import { ingestDocument, queryDocuments } from "./agents/document-rag";
import { runDataAnalyst, storeCsvUpload } from "./agents/data-analyst";
import { runAgentChat } from "./agents/agent-chat";
import { parseBotActivity, sendBotReplyWithToken } from "../../integrations/teams/bot";
import { SupabaseClient } from "./db/client";
import { orchestrations } from "./registry";

// Re-export the WorkflowEntrypoint so Cloudflare can locate the class by name.
export { RunOrchestration } from "./workflow";

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

    // Dispatch to the durable Workflow — the cron handler just needs to kick it off.
    try {
      await env.ORCHESTRATION_WORKFLOW.create({
        id: run.id,
        params: { runId: run.id, orchestrationName: orch.name },
      });
      console.log(`[cron] ${orch.name} dispatched to Workflow (run ${run.id})`);
    } catch (err) {
      await db.updateRun(run.id, {
        status: "failed",
        error: { message: err instanceof Error ? err.message : String(err) },
        ended_at: new Date().toISOString(),
      });
      console.error(`[cron] ${orch.name} failed to dispatch (run ${run.id}):`, err);
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      const runMatch = pathname.match(/^\/api\/orchestrations\/([^/]+)\/run$/);
      if (runMatch && request.method === "POST") {
        const name = decodeURIComponent(runMatch[1] ?? "");
        const orch = orchestrations.get(name);
        if (!orch) return json({ error: `Orchestration "${name}" not found` }, 404);

        let body: unknown;
        try { body = await request.json(); }
        catch { return json({ error: "Invalid JSON body" }, 400); }

        const parsed = orch.inputSchema.safeParse(body);
        if (!parsed.success) {
          return json({ error: "Invalid input", issues: parsed.error.issues }, 422);
        }

        const db = new SupabaseClient(env);
        const orchRecord = await db.getOrchestrationByName(name, orch.version);
        const run = await db.createRun({
          orchestration_id: orchRecord.id,
          orchestration_version: orch.version,
          status: "running",
          input: parsed.data,
          triggered_by: "webhook",
          started_at: new Date().toISOString(),
        });

        // Dispatch to the durable Workflow; returns 202 immediately.
        await env.ORCHESTRATION_WORKFLOW.create({
          id: run.id,
          params: { runId: run.id, orchestrationName: name },
        });

        return json({ runId: run.id, status: "running" }, 202);
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

      // ── Data Analyst: query ─────────────────────────────────────────────────
      if (pathname === "/api/analyst/query" && request.method === "POST") {
        const body = await request.json() as {
          question: string;
          tables?: string[];
          maxRows?: number;
          sessionKey?: string;
        };

        if (!body.question) {
          return json({ error: "question is required" }, 400);
        }

        const result = await runDataAnalyst(env, body);
        return json(result);
      }

      // ── Data Analyst: CSV upload ────────────────────────────────────────────
      if (pathname === "/api/analyst/upload-csv" && request.method === "POST") {
        const body = await request.json() as {
          sessionKey: string;
          sourceName: string;
          csvContent: string;   // raw CSV text
        };

        if (!body.sessionKey || !body.sourceName || !body.csvContent) {
          return json({ error: "sessionKey, sourceName, and csvContent are required" }, 400);
        }

        // Parse CSV: first line = headers, rest = rows (max 5000)
        const lines = body.csvContent.trim().split(/\r?\n/);
        if (lines.length < 2) {
          return json({ error: "CSV must have at least a header row and one data row" }, 400);
        }

        const colNames = parseCsvLine(lines[0] ?? "");
        const rows = lines.slice(1, 5001).map((line) => {
          const vals = parseCsvLine(line);
          const row: Record<string, string> = {};
          colNames.forEach((col, i) => { row[col] = vals[i] ?? ""; });
          return row;
        });

        const result = await storeCsvUpload(env, {
          sessionKey: body.sessionKey,
          sourceName: body.sourceName,
          rows,
          colNames,
        });

        return json(result);
      }

      // ── Approval response: POST /api/approvals/:id/respond ──────────────────
      // In Workflow mode the sleeping Workflow polls for this decision automatically —
      // no replay needed. Just record the decision and return.
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

        // Persist the decision — the Workflow's next poll will pick it up.
        await db.respondToApproval(approvalId, {
          approved: body.approved,
          decidedBy: decidedByUserId,
          ...(body.notes !== undefined && { notes: body.notes }),
        });

        const approval = await db.getApproval(approvalId);
        return json({ runId: approval.run_id, status: body.approved ? "approved" : "rejected" });
      }

      // ── Agent chat: POST /api/agents/:slug/chat ─────────────────────────────
      const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)\/chat$/);
      if (agentMatch && request.method === "POST") {
        const slug = agentMatch[1] as "angie" | "beady" | "patch" | "money";

        let body: { messages?: unknown; files?: unknown };
        try { body = await request.json() as typeof body; }
        catch { return json({ error: "Invalid JSON body" }, 400); }

        const runtimeUrl = `${url.protocol}//${url.host}`;
        const chatReq: import("./agents/agent-chat").AgentChatRequest = {
          agentSlug: slug,
          messages: (body.messages ?? []) as import("./agents/agent-chat").ChatMessage[],
        };
        const rawFiles = body.files as import("./agents/agent-chat").FileAttachment[] | undefined;
        if (rawFiles?.length) chatReq.files = rawFiles;
        const result = await runAgentChat(env, chatReq, runtimeUrl);

        return json(result);
      }

      // ── Teams Bot: POST /api/teams/bot ───────────────────────────────────────
      if (pathname === "/api/teams/bot" && request.method === "POST") {
        const parsed = await parseBotActivity(request, env);

        if (!parsed.valid || !parsed.activity) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Only handle "message" activities; ignore conversationUpdate etc.
        if (parsed.activity.type !== "message" || !parsed.text) {
          return new Response(null, { status: 200 });
        }

        const slug = (parsed.agentSlug ?? "patch") as "angie" | "beady" | "patch" | "money";
        const runtimeUrl = `${url.protocol}//${url.host}`;

        // Run the agent chat (fire and forget the reply so Teams doesn't time out)
        const chatPromise = runAgentChat(env, {
          agentSlug: slug,
          messages: [{ role: "user", content: parsed.text }],
        }, runtimeUrl).then(async (result) => {
          const replyText = result.runIds.length > 0
            ? `${result.reply}\n\n*Run IDs: ${result.runIds.join(", ")}*`
            : result.reply;
          await sendBotReplyWithToken(
            env,
            parsed.serviceUrl,
            parsed.conversationId,
            parsed.activity!.id,
            replyText,
          );
        }).catch((err) => {
          console.error("[teams-bot] reply error:", err);
        });

        // Use waitUntil so the reply finishes sending after the 200 response
        ctx.waitUntil(chatPromise);

        return new Response(null, { status: 200 });
      }

      // ── Vault webhook: POST /api/vault/webhook ──────────────────────────────
      // Receives GitHub push events and triggers patch/vault-sync for changed files.
      if (pathname === "/api/vault/webhook" && request.method === "POST") {
        // Verify GitHub signature if secret is configured
        if (env.GITHUB_WEBHOOK_SECRET) {
          const sig = request.headers.get("X-Hub-Signature-256") ?? "";
          const body = await request.text();
          const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          );
          const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
          const expected = "sha256=" + Array.from(new Uint8Array(mac))
            .map((b) => b.toString(16).padStart(2, "0")).join("");
          if (sig !== expected) {
            return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
          }
          const payload = JSON.parse(body) as {
            repository: { owner: { login: string }; name: string };
            ref: string;
            commits: Array<{ added: string[]; modified: string[]; removed: string[] }>;
          };
          return handleVaultWebhook(payload, env);
        } else {
          const payload = await request.json() as {
            repository: { owner: { login: string }; name: string };
            ref: string;
            commits: Array<{ added: string[]; modified: string[]; removed: string[] }>;
          };
          return handleVaultWebhook(payload, env);
        }
      }

      // ── Vault full sync: POST /api/vault/sync (ops only) ───────────────────
      if (pathname === "/api/vault/sync" && request.method === "POST") {
        const authResult = requireOpsToken(request);
        if (authResult instanceof Response) return authResult;

        const body = await request.json() as { repoOwner: string; repoName: string; branch?: string };
        if (!body.repoOwner || !body.repoName) {
          return json({ error: "repoOwner and repoName are required" }, 400);
        }

        const db = new SupabaseClient(env);
        const orchRecord = await db.getOrchestrationByName("patch/vault-sync", 1);
        const run = await db.createRun({
          orchestration_id: orchRecord.id,
          orchestration_version: 1,
          status: "running",
          input: body,
          triggered_by: "webhook",
          started_at: new Date().toISOString(),
        });

        await env.ORCHESTRATION_WORKFLOW.create({
          id: run.id,
          params: { runId: run.id, orchestrationName: "patch/vault-sync" },
        });

        return json({ runId: run.id, status: "running" }, 202);
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

// ─── Vault webhook helper ────────────────────────────────────────────────────

async function handleVaultWebhook(
  payload: {
    repository: { owner: { login: string }; name: string };
    ref: string;
    commits: Array<{ added: string[]; modified: string[]; removed: string[] }>;
  },
  env: Env,
): Promise<Response> {
  const owner  = payload.repository.owner.login;
  const repo   = payload.repository.name;
  const branch = payload.ref.replace("refs/heads/", "");

  const changedSet = new Set<string>();
  const removedSet = new Set<string>();

  for (const commit of payload.commits) {
    for (const f of [...commit.added, ...commit.modified]) changedSet.add(f);
    for (const f of commit.removed) removedSet.add(f);
  }

  const changedPaths = [...changedSet].filter((p) => p.endsWith(".md"));
  const removedPaths = [...removedSet].filter((p) => p.endsWith(".md"));

  if (changedPaths.length === 0 && removedPaths.length === 0) {
    return new Response(JSON.stringify({ status: "no markdown changes" }), { status: 200 });
  }

  const db = new SupabaseClient(env);
  let orchRecord: Awaited<ReturnType<typeof db.getOrchestrationByName>>;
  try {
    orchRecord = await db.getOrchestrationByName("patch/vault-sync", 1);
  } catch {
    return new Response(JSON.stringify({ error: "vault-sync orchestration not registered in DB" }), { status: 500 });
  }

  const input = { repoOwner: owner, repoName: repo, branch, changedPaths, removedPaths };

  const run = await db.createRun({
    orchestration_id: orchRecord.id,
    orchestration_version: 1,
    status: "running",
    input,
    triggered_by: "webhook",
    started_at: new Date().toISOString(),
  });

  await env.ORCHESTRATION_WORKFLOW.create({
    id: run.id,
    params: { runId: run.id, orchestrationName: "patch/vault-sync" },
  });

  return new Response(
    JSON.stringify({ runId: run.id, changedPaths: changedPaths.length, removedPaths: removedPaths.length }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
}

// ─── CSV line parser (handles quoted fields with commas) ─────────────────────

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

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
