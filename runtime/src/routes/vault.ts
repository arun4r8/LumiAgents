import type { Env } from "../types";
import { SupabaseClient } from "../db/client";
import { json, requireOpsToken } from "./helpers";

const VAULT_BRANCH = "main";

async function ghFetch<T>(
  env: Env,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: options?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${env.GITHUB_API_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lumiagents/1.0",
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${options?.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function handleVault(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;

  // POST /api/vault/webhook: GitHub push event → patch/vault-sync
  if (pathname === "/api/vault/webhook" && request.method === "POST") {
    // GitHub sends a ping event when a webhook is first created or tested, so acknowledge it.
    if (request.headers.get("X-GitHub-Event") === "ping") {
      return new Response(JSON.stringify({ status: "pong" }), { status: 200 });
    }
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

  // POST /api/vault/sync: ops-only manual full sync
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

  // GET /api/vault/files/tree: list all markdown files in the vault
  if (pathname === "/api/vault/files/tree" && request.method === "GET") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const tree = await ghFetch<{
      tree: Array<{ path: string; type: string; sha: string; size?: number }>;
    }>(env, `/repos/${env.VAULT_OWNER}/${env.VAULT_REPO}/git/trees/${VAULT_BRANCH}?recursive=1`);

    const files = tree.tree
      .filter((e) => e.type === "blob" && e.path.endsWith(".md") && !e.path.startsWith(".obsidian/"))
      .map((e) => ({ path: e.path, sha: e.sha }));

    return json({ files });
  }

  // GET /api/vault/files?path=... : fetch a single file's content
  if (pathname === "/api/vault/files" && request.method === "GET") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const filePath = url.searchParams.get("path");
    if (!filePath) return json({ error: "path query param is required" }, 400);

    const data = await ghFetch<{ content: string; sha: string; encoding: string }>(
      env,
      `/repos/${env.VAULT_OWNER}/${env.VAULT_REPO}/contents/${encodeURIComponent(filePath)}?ref=${VAULT_BRANCH}`,
    );

    if (data.encoding !== "base64") return json({ error: "unexpected encoding" }, 500);
    const content = atob(data.content.replace(/\n/g, ""));
    return json({ path: filePath, content, sha: data.sha });
  }

  // PUT /api/vault/files: create or update a file
  if (pathname === "/api/vault/files" && request.method === "PUT") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const body = await request.json() as {
      path: string;
      content: string;
      sha?: string;
      message?: string;
    };
    if (!body.path || body.content === undefined) {
      return json({ error: "path and content are required" }, 400);
    }

    const reqBody: Record<string, unknown> = {
      message: body.message ?? `Update ${body.path}`,
      content: btoa(unescape(encodeURIComponent(body.content))),
      branch: VAULT_BRANCH,
    };
    if (body.sha) reqBody["sha"] = body.sha;

    const result = await ghFetch<{ content: { path: string; sha: string } }>(
      env,
      `/repos/${env.VAULT_OWNER}/${env.VAULT_REPO}/contents/${encodeURIComponent(body.path)}`,
      { method: "PUT", body: reqBody },
    );

    return json({ path: result.content.path, sha: result.content.sha });
  }

  // DELETE /api/vault/files: delete a file
  if (pathname === "/api/vault/files" && request.method === "DELETE") {
    const authResult = await requireOpsToken(request, env);
    if (authResult instanceof Response) return authResult;

    const body = await request.json() as { path: string; sha: string; message?: string };
    if (!body.path || !body.sha) return json({ error: "path and sha are required" }, 400);

    await ghFetch<unknown>(
      env,
      `/repos/${env.VAULT_OWNER}/${env.VAULT_REPO}/contents/${encodeURIComponent(body.path)}`,
      {
        method: "DELETE",
        body: {
          message: body.message ?? `Delete ${body.path}`,
          sha: body.sha,
          branch: VAULT_BRANCH,
        },
      },
    );

    return json({ deleted: true });
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
