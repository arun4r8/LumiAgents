export const RUNTIME_URL = process.env.E2E_RUNTIME_URL ?? process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";
export const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Cached per process: sign in once, reuse for the whole test run.
let _token: string | null = null;

export async function getOpsToken(): Promise<string> {
  if (process.env.E2E_OPS_TOKEN) return process.env.E2E_OPS_TOKEN;
  if (_token) return _token;

  const email = process.env.E2E_OPS_EMAIL;
  const password = process.env.E2E_OPS_PASSWORD;
  if (!email || !password) throw new Error("Set E2E_OPS_TOKEN or E2E_OPS_EMAIL + E2E_OPS_PASSWORD");

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`E2E sign-in failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { access_token: string };
  _token = data.access_token;
  return _token;
}

export async function authHeaders(): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${await getOpsToken()}`,
  };
}

// Poll Supabase until the run reaches a terminal state or times out.
export async function pollRun(runId: string, timeoutMs = 120_000): Promise<{ status: string; output: unknown }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "(no poll yet)";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const token = await getOpsToken();
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/runs?id=eq.${runId}&select=status,output&limit=1`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
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
  throw new Error(`Run ${runId} did not complete within ${timeoutMs / 1000}s; last poll: ${lastStatus}`);
}

export async function triggerRun(name: string, input: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${RUNTIME_URL}/api/orchestrations/${encodeURIComponent(name)}/run`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trigger ${name} → ${res.status}: ${text}`);
  }
  const data = await res.json() as { runId: string };
  return data.runId;
}
