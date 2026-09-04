"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOps } from "@/lib/require-ops";
import { revalidatePath } from "next/cache";
import { fetchRuntime } from "@/lib/runtime-fetch";

// Tier 2 agent builder (#67). Ops-only server action: forward a capability proposal to the
// runtime's ops-gated draft endpoint, which generates the file set and opens a human-merge-gated
// PR. Build 2 broadens the proposal to THREE kinds — a new tool (orchestration), a new data table,
// or a new dedicated-Worker agent — each carrying a `kind` the runtime routes on. This action ONLY
// drafts — it never merges, and there is no merge path anywhere in the dashboard. The runtime
// re-checks ops on its side (it holds the GitHub App credential); this requireOps() is the
// caller-side gate, mirroring Tier 1's createAgent.


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

/** A pending proposal as the runtime records it (orchestration.agent_proposals). */
export interface PendingProposal {
  id: string;
  kind: string;
  agent_slug: string | null;
  target: string | null;
  pr_number: number;
  pr_url: string;
  branch: string | null;
  status: string;
  created_at: string;
}

export type ProposalListResult =
  | { ok: true; proposals: PendingProposal[]; reconciled: boolean }
  | { ok: false; error: string };

export type CancelResult = { ok: true; prClosed: boolean } | { ok: false; error: string };

async function opsToken(): Promise<string | null> {
  const sb = await createClient();
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token ?? null;
}

export async function proposeCapability(input: ProposeCapabilityInput): Promise<ProposeResult> {
  await requireOps();

  const sb = await createClient();
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session) return { ok: false, error: "Not authenticated." };

  let res: Response;
  try {
    res = await fetchRuntime(`/api/agent-builder/tier2/draft`, {
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

  // Refresh the surfaces that show pending proposals. A table proposal is not tied to an agent.
  if (input.kind === "orchestration") revalidatePath(`/agents/${input.agentSlug}`);
  revalidatePath("/agents");

  return { ok: true, prUrl: data.prUrl, prNumber: data.prNumber, branch: data.branch, kind: data.kind ?? input.kind };
}

// ─── The way OUT of a pending proposal (#67 audit) ────────────────────────────────
//
// Nothing used to clear a proposal: there is no merge webhook and there was no PR polling, so an
// agent pushed into `proposed` was stranded forever. Both exits are ops-driven and pull-based:
// reconcile (ask GitHub whether the PR merged or closed) and cancel (abandon it outright).

/**
 * Ask the runtime for this agent's pending proposals. The runtime reconciles each against its
 * GitHub PR first, so a merged or closed-unmerged PR clears itself here.
 */
export async function listProposals(agentSlug: string): Promise<ProposalListResult> {
  await requireOps();
  const token = await opsToken();
  if (!token) return { ok: false, error: "Not authenticated." };

  let res: Response;
  try {
    res = await fetchRuntime(`/api/agent-builder/tier2/proposals?agentSlug=${encodeURIComponent(agentSlug)}`,
      { cache: "no-store", headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the runtime." };
  }

  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    proposals?: PendingProposal[];
    reconciled?: boolean;
  };
  if (!res.ok) return { ok: false, error: data.error ?? `Could not list proposals (${res.status}).` };

  revalidatePath(`/agents/${agentSlug}`);
  return { ok: true, proposals: data.proposals ?? [], reconciled: Boolean(data.reconciled) };
}

/** Ops abandons a pending proposal: clears the record and (best-effort) closes the PR. */
export async function cancelProposal(agentSlug: string, prNumber: number): Promise<CancelResult> {
  await requireOps();
  const token = await opsToken();
  if (!token) return { ok: false, error: "Not authenticated." };

  let res: Response;
  try {
    res = await fetchRuntime(`/api/agent-builder/tier2/proposals/cancel`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prNumber }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the runtime." };
  }

  const data = (await res.json().catch(() => ({}))) as { error?: string; prClosed?: boolean };
  if (!res.ok) return { ok: false, error: data.error ?? `Could not cancel the proposal (${res.status}).` };

  revalidatePath(`/agents/${agentSlug}`);
  revalidatePath("/agents");
  return { ok: true, prClosed: Boolean(data.prClosed) };
}
