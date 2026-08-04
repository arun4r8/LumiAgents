"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOps } from "@/lib/require-ops";
import { revalidatePath } from "next/cache";

// Tier 2 agent builder (#67). Ops-only server action: forward a capability proposal to the
// runtime's ops-gated draft endpoint, which generates the file set and opens a human-merge-gated
// PR. Build 2 broadens the proposal to THREE kinds — a new tool (orchestration), a new data table,
// or a new dedicated-Worker agent — each carrying a `kind` the runtime routes on. This action ONLY
// drafts — it never merges, and there is no merge path anywhere in the dashboard. The runtime
// re-checks ops on its side (it holds the GitHub App credential); this requireOps() is the
// caller-side gate, mirroring Tier 1's createAgent.

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

export type ProposeFieldType = "string" | "number" | "boolean";

export interface ProposeField {
  name: string;
  type: ProposeFieldType;
  description: string;
  optional?: boolean;
}

export type ProposeColumnType =
  | "text"
  | "int"
  | "bigint"
  | "boolean"
  | "timestamptz"
  | "jsonb"
  | "uuid"
  | "date"
  | "numeric";

export interface ProposeColumn {
  name: string;
  type: ProposeColumnType;
  nullable: boolean;
}

/** New tool (Build 1): a new orchestration for an existing agent. */
export interface OrchestrationProposal {
  kind: "orchestration";
  agentSlug: string;
  capabilitySlug: string;
  description: string;
  intent: string;
  inputFields: ProposeField[];
  output: ProposeField[];
}

/** New data table (Build 2): a new forward-only domain table with RLS. */
export interface TableProposal {
  kind: "table";
  tableName: string;
  columns: ProposeColumn[];
  enduserReadable: boolean;
  description?: string;
}

/** New agent (Build 2): a scaffold for a new dedicated-Worker agent. */
export interface AgentProposal {
  kind: "agent";
  slug: string;
  displayName: string;
  card: {
    emoji?: string;
    category?: string;
    description?: string;
    suggestedPrompts?: string[];
  };
  persona: string;
  tools: string[];
  secrets?: string[];
}

export type ProposeCapabilityInput = OrchestrationProposal | TableProposal | AgentProposal;

export type ProposeResult =
  | { ok: true; prUrl: string; prNumber: number; branch: string; kind: string }
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
    kind?: string;
  };

  if (!res.ok) {
    const detail = data.details?.length ? `: ${data.details.join("; ")}` : "";
    return { ok: false, error: `${data.error ?? `Draft failed (${res.status})`}${detail}` };
  }
  if (!data.prUrl || data.prNumber === undefined || !data.branch) {
    return { ok: false, error: "Runtime did not return a PR." };
  }

  // Refresh the surfaces that show proposed state. A table proposal is not tied to an agent.
  if (input.kind === "orchestration") revalidatePath(`/agents/${input.agentSlug}`);
  revalidatePath("/agents");

  return { ok: true, prUrl: data.prUrl, prNumber: data.prNumber, branch: data.branch, kind: data.kind ?? input.kind };
}
