import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const CF_BASE = "https://api.cloudflare.com/client/v4";

async function getCfConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const scriptName =
    process.env.CF_WORKER_SCRIPT_NAME ?? "lumiagents-runtime";
  return { accountId, token, scriptName };
}

async function authCheck(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user != null;
}

// GET /api/cf/secrets: list secret names
export async function GET(): Promise<NextResponse> {
  if (!(await authCheck())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { accountId, token, scriptName } = await getCfConfig();
  if (!accountId || !token) {
    return NextResponse.json(
      { error: "CF credentials not configured" },
      { status: 503 }
    );
  }

  try {
    const res = await fetch(
      `${CF_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/secrets`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Cloudflare API error: ${res.status}`, detail: text },
        { status: 502 }
      );
    }

    const data = (await res.json()) as { result?: unknown[] };
    return NextResponse.json(data.result ?? []);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const CreateSecretSchema = z.object({
  name: z.string().min(1),
  text: z.string().min(1),
});

// POST /api/cf/secrets: create or update a secret
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!(await authCheck())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { accountId, token, scriptName } = await getCfConfig();
  if (!accountId || !token) {
    return NextResponse.json(
      { error: "CF credentials not configured" },
      { status: 503 }
    );
  }

  let body: z.infer<typeof CreateSecretSchema>;
  try {
    const raw: unknown = await req.json();
    body = CreateSecretSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${CF_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/secrets`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: body.name, text: body.text, type: "secret_text" }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Cloudflare API error: ${res.status}`, detail: text },
        { status: 502 }
      );
    }

    const data: unknown = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const DeleteSecretSchema = z.object({
  name: z.string().min(1),
});

// DELETE /api/cf/secrets: delete a secret by name
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  if (!(await authCheck())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { accountId, token, scriptName } = await getCfConfig();
  if (!accountId || !token) {
    return NextResponse.json(
      { error: "CF credentials not configured" },
      { status: 503 }
    );
  }

  let body: z.infer<typeof DeleteSecretSchema>;
  try {
    const raw: unknown = await req.json();
    body = DeleteSecretSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${CF_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/secrets/${encodeURIComponent(body.name)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Cloudflare API error: ${res.status}`, detail: text },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
