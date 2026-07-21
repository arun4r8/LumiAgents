// Drains the public.n8n_call_queue table, firing up to `slots` pending webhook
// calls per invocation. Called from the main cron handler alongside schedule dispatch.
// Binary payloads are not supported here; callers should upload to Storage first.

const N8N_BASE = "https://lumiture.app.n8n.cloud/webhook";
const N8N_CONCURRENCY_CAP = 5;

interface QueueRow {
  id: string;
  webhook_path: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function drainN8nCallQueue(env: {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  N8N_WEBHOOK_SECRET?: string;
}): Promise<void> {
  const supabaseHeaders = {
    "Content-Type": "application/json",
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  // Claim pending calls atomically (SKIP LOCKED in the RPC prevents double-fire)
  const claimRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/claim_n8n_calls`, {
    method: "POST",
    headers: supabaseHeaders,
    body: JSON.stringify({ p_limit: N8N_CONCURRENCY_CAP }),
  });

  if (!claimRes.ok) {
    console.error("[n8n-queue] claim_n8n_calls failed:", await claimRes.text());
    return;
  }

  const calls = (await claimRes.json()) as QueueRow[];
  if (calls.length === 0) return;

  console.log(`[n8n-queue] firing ${calls.length} queued n8n call(s)`);

  await Promise.all(
    calls.map(async (call) => {
      const webhookHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (env.N8N_WEBHOOK_SECRET) webhookHeaders["X-Webhook-Secret"] = env.N8N_WEBHOOK_SECRET;

      let succeeded = false;
      let lastError: string | null = null;

      try {
        const res = await fetch(`${N8N_BASE}/${call.webhook_path}`, {
          method: "POST",
          headers: webhookHeaders,
          body: JSON.stringify(call.payload),
        });
        if (!res.ok) {
          throw new Error(`n8n ${call.webhook_path} → ${res.status}: ${await res.text()}`);
        }
        succeeded = true;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`[n8n-queue] call ${call.id} failed (attempt ${call.attempts}):`, lastError);
      }

      const exhausted = call.attempts >= call.max_attempts;
      const newStatus: string = succeeded ? "done" : exhausted ? "failed" : "pending";

      await fetch(`${env.SUPABASE_URL}/rest/v1/n8n_call_queue?id=eq.${call.id}`, {
        method: "PATCH",
        headers: supabaseHeaders,
        body: JSON.stringify({
          status: newStatus,
          ...(lastError ? { last_error: lastError } : {}),
        }),
      });
    }),
  );
}
