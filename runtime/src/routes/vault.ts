import type { Env } from "../types";
import { SupabaseClient } from "../db/client";
import { json, requireOpsToken } from "./helpers";

export async function handleVault(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;

  // POST /api/vault/webhook — GitHub push event → patch/vault-sync
  if (pathname === "/api/vault/webhook" && request.method === "POST") {
    type PushPayload = {
      repository: { owner: { login: string }; name: string };
      ref: string;
      commits: Array<{ added: string[]; modified: string[]; removed: string[] }>;
    };

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
      return dispatchVaultSync(JSON.parse(body) as PushPayload, env);
    }

    const payload = await request.json() as PushPayload;
    return dispatchVaultSync(payload, env);
  }

  // POST /api/vault/sync — ops-only manual full sync
  if (pathname === "/api/vault/sync" && request.method === "POST") {
    const authResult = await requireOpsToken(request, env);
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
      triggered_by: "user",
      started_at: new Date().toISOString(),
    });

    await env.ORCHESTRATION_WORKFLOW.create({
      id: run.id,
      params: { runId: run.id, orchestrationName: "patch/vault-sync" },
    });

    return json({ runId: run.id, status: "running" }, 202);
  }

  return null;
}

async function dispatchVaultSync(
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
    return new Response(
      JSON.stringify({ error: "vault-sync orchestration not registered in DB" }),
      { status: 500 },
    );
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
