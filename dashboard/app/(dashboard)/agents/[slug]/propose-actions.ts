"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOps } from "@/lib/require-ops";
import { revalidatePath } from "next/cache";

// Tier 2 agent builder (#67). Ops-only server action: forward a capability proposal to the
// runtime's ops-gated draft endpoint, which generates the orchestration package and opens a
// human-merge-gated PR. This action ONLY drafts — it never merges, and there is no merge path
// anywhere in the dashboard. The runtime re-checks ops on its side (it holds the GitHub App
// credential); this requireOps() is the caller-side gate, mirroring Tier 1's createAgent.

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

export type ProposeFieldType = "string" | "number" | "boolean";

export interface ProposeField {
  name: string;
  type: ProposeFieldType;
  description: string;
  optional?: boolean;
}

export interface ProposeCapabilityInput {
  agentSlug: string;
  capabilitySlug: string;
  description: string;
  intent: string;
  inputFields: ProposeField[];
  output: ProposeField[];
}

export type ProposeResult =
  | { ok: true; prUrl: string; prNumber: number; branch: string }
  | { ok: false; error: string };

export async function proposeCapability(input: ProposeCapabilityInput): Promise<ProposeResult> {
  await requireOps();

  const sb = await createClient();
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session) return { ok: false, error: "Not authenticated." };

  let res: Response;
  try {
    res = await fetch(`${RUNTIME}/api/agent-builder/tier2/draft`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the runtime." };
  }

  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    details?: string[];
    prUrl?: string;
    prNumber?: number;
    branch?: string;
  };

  if (!res.ok) {
    const detail = data.details?.length ? `: ${data.details.join("; ")}` : "";
    return { ok: false, error: `${data.error ?? `Draft failed (${res.status})`}${detail}` };
  }
  if (!data.prUrl || data.prNumber === undefined || !data.branch) {
    return { ok: false, error: "Runtime did not return a PR." };
  }

  revalidatePath(`/agents/${input.agentSlug}`);
  return { ok: true, prUrl: data.prUrl, prNumber: data.prNumber, branch: data.branch };
}
