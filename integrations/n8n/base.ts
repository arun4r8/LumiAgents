import type { RunContext } from "../../runtime/src/types";

const N8N_BASE = "https://lumiture.app.n8n.cloud/webhook";

export async function callN8nWebhook<T>(
  ctx: RunContext,
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (idempotencyKey) {
    headers["X-Idempotency-Key"] = idempotencyKey;
  }

  if (ctx.env.N8N_WEBHOOK_SECRET) {
    headers["X-Webhook-Secret"] = ctx.env.N8N_WEBHOOK_SECRET;
  }

  const res = await ctx.fetch(`${N8N_BASE}/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`n8n webhook ${path} → ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}
