import { createHmac } from "node:crypto";

export const RUNTIME_URL = process.env.E2E_RUNTIME_URL ?? process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";
export const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Use a pre-generated token (CI) or mint one on the fly from the local JWT secret.
export function getOpsToken(): string {
  if (process.env.E2E_OPS_TOKEN) return process.env.E2E_OPS_TOKEN;

  const jwtSecret = process.env.SUPABASE_JWT_SECRET ?? "";
  if (!jwtSecret) throw new Error("Set E2E_OPS_TOKEN or SUPABASE_JWT_SECRET");

  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: "e2e-test-runner",
    role: "authenticated",          // PostgREST: SET ROLE authenticated (real Postgres role)
    user_role: "ops",               // requireOpsToken custom claim
    app_metadata: { role: "ops" }, // is_ops() RLS helper checks this branch
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  const sig = createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getOpsToken()}`,
  };
}

// Poll Supabase until the run reaches a terminal state or times out.
export async function pollRun(runId: string, timeoutMs = 120_000): Promise<{ status: string; output: unknown }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "(no poll yet)";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/runs?id=eq.${runId}&select=status,output&limit=1`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${getOpsToken()}`,
          "Accept-Profile": "orchestration",
        },
      },
    );
    if (!res.ok) {
      const body = await res.text();
      lastStatus = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      console.warn(`[pollRun] ${runId}: ${lastStatus}`);
      continue;
    }
    const rows = await res.json() as Array<{ status: string; output: unknown }>;
    if (rows.length === 0) {
      lastStatus = "0 rows (RLS filtering or run not yet written)";
      console.warn(`[pollRun] ${runId}: ${lastStatus}`);
      continue;
    }
    const row = rows[0];
    lastStatus = `status=${row!.status}`;
    if (row!.status === "completed" || row!.status === "failed") return row!;
  }
  throw new Error(`Run ${runId} did not complete within ${timeoutMs / 1000}s — last poll: ${lastStatus}`);
}

export async function triggerRun(name: string, input: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${RUNTIME_URL}/api/orchestrations/${encodeURIComponent(name)}/run`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trigger ${name} → ${res.status}: ${text}`);
  }
  const data = await res.json() as { runId: string };
  return data.runId;
}
