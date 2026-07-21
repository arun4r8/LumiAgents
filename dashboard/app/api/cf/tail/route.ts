import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const CF_BASE = "https://api.cloudflare.com/client/v4";

async function authCheck(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user != null;
}

function getCfConfig() {
  return {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_API_TOKEN ?? "",
    scriptName: process.env.CF_WORKER_SCRIPT_NAME ?? "lumiagents-runtime",
  };
}

// POST /api/cf/tail: create a tail session
export async function POST(_req: NextRequest): Promise<NextResponse> {
  if (!(await authCheck())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { accountId, token, scriptName } = getCfConfig();
  if (!accountId || !token) {
    return NextResponse.json(
      { error: "CF credentials not configured" },
      { status: 503 }
    );
  }

  try {
    const res = await fetch(
      `${CF_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/tails`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Cloudflare API error: ${res.status}`, detail: text },
        { status: 502 }
      );
    }

    const data = (await res.json()) as {
      result?: { id: string; url: string; expires_at: string };
    };

    if (!data.result) {
      return NextResponse.json(
        { error: "Unexpected response from Cloudflare" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      id: data.result.id,
      url: data.result.url,
      expires_at: data.result.expires_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const DeleteTailSchema = z.object({
  tailId: z.string().min(1),
});

// DELETE /api/cf/tail: delete a tail session
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  if (!(await authCheck())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { accountId, token, scriptName } = getCfConfig();
  if (!accountId || !token) {
    return NextResponse.json(
      { error: "CF credentials not configured" },
      { status: 503 }
    );
  }

  let body: z.infer<typeof DeleteTailSchema>;
  try {
    const raw: unknown = await req.json();
    body = DeleteTailSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${CF_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/tails/${encodeURIComponent(body.tailId)}`,
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
