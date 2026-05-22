import type { RunContext } from "../../runtime/src/types";

const N8N_BASE = "https://lumiture.app.n8n.cloud/webhook";

async function handleResponse<T>(res: Response, path: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`n8n webhook ${path} → ${res.status}: ${text}`);
  }
  const text = await res.text();
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

export async function callN8nWebhook<T>(
  ctx: RunContext,
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
  if (ctx.env.N8N_WEBHOOK_SECRET) headers["X-Webhook-Secret"] = ctx.env.N8N_WEBHOOK_SECRET;

  const res = await ctx.fetch(`${N8N_BASE}/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return handleResponse<T>(res, path);
}

export interface N8nFile {
  fieldName: string;
  filename: string;
  base64: string;
  mimeType?: string;
}

// Send multipart/form-data with binary file attachments.
// n8n reads text fields from $json.body.* and binary data from $binary.
// Do NOT pass Content-Type — fetch sets it automatically with the correct multipart boundary.
export async function callN8nWebhookMultipart<T>(
  ctx: RunContext,
  path: string,
  fields: Record<string, string>,
  files: N8nFile[],
  idempotencyKey?: string,
): Promise<T> {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }

  for (const file of files) {
    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: file.mimeType ?? "application/pdf" });
    form.append(file.fieldName, blob, file.filename);
  }

  const headers: Record<string, string> = {};
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
  if (ctx.env.N8N_WEBHOOK_SECRET) headers["X-Webhook-Secret"] = ctx.env.N8N_WEBHOOK_SECRET;

  const res = await ctx.fetch(`${N8N_BASE}/${path}`, {
    method: "POST",
    headers,
    body: form,
  });

  return handleResponse<T>(res, path);
}
