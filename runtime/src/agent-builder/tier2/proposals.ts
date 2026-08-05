// Tier 2 agent builder (#67) — the proposal record and its way OUT of the pending state.
//
// Two audit findings drive this module:
//
//   1. Proposing a capability used to PATCH the DONOR agent's catalog row to
//      `lifecycle='proposed'`. The agents list filters non-ops callers to `lifecycle='active'`,
//      so "propose a new tool for Cleo" deleted Cleo from every enduser's Agents page. A pending
//      proposal is metadata ABOUT an agent, not a change to whether that agent works — so it now
//      lives in its own table and touches nothing an enduser can see.
//
//   2. Nothing ever cleared `proposed`. There was no merge webhook and no PR polling, so any
//      agent that entered the state was stranded there forever and the PR body's promise that
//      "the agent leaves the proposed state" on merge was simply false. The way out is pull-based
//      and deliberately webhook-free: `reconcileProposal` asks GitHub about the recorded PR
//      (merged → 'merged'; closed-unmerged → 'closed'), and ops can always `cancel` by hand.
//
// The record also fixes the third finding — `markProposed` was a silent no-op for kind:"agent",
// because that agent's catalog row does not exist until the PR merges and a PostgREST PATCH
// matching zero rows returns 204. An insert into a proposals table needs no pre-existing row.

import type { Env } from "../../types";
import { ghAppFetch as realGhAppFetch, type GhAppFetch } from "../../integrations/github/app-auth";

const REPO = "LumitureLabs/LumiAgents";

export type ProposalKind = "orchestration" | "table" | "agent";
export type ProposalStatus = "open" | "merged" | "closed" | "cancelled";

export interface ProposalRow {
  id: string;
  kind: ProposalKind;
  agent_slug: string | null;
  target: string | null;
  pr_number: number;
  pr_url: string;
  branch: string | null;
  status: ProposalStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewProposal {
  kind: ProposalKind;
  /** Donor agent (orchestration kind) or the proposed agent's slug (agent kind); null for tables. */
  agentSlug: string | null;
  /** What is being proposed: capability slug / table name / agent slug. */
  target: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  createdBy: string | null;
}

function restHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Accept-Profile": "orchestration",
    "Content-Profile": "orchestration",
    ...extra,
  };
}

// ─── write ────────────────────────────────────────────────────────────────────────

/**
 * Record an open proposal. Upserts on pr_number so a re-draft that adopts an already-open PR
 * (see openPR's "pull request already exists" recovery) updates the row instead of duplicating it.
 *
 * Crucially this writes NOTHING to orchestration.agents — the donor agent keeps its lifecycle and
 * stays visible to every enduser while its proposal is pending.
 */
export async function recordProposal(env: Env, p: NewProposal): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/agent_proposals?on_conflict=pr_number`, {
    method: "POST",
    headers: restHeaders(env, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({
      kind: p.kind,
      agent_slug: p.agentSlug,
      target: p.target,
      pr_number: p.prNumber,
      pr_url: p.prUrl,
      branch: p.branch,
      status: "open",
      created_by: p.createdBy,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    throw new Error(`record-proposal POST agent_proposals → ${res.status}: ${await res.text()}`);
  }
}

/** Set a proposal's status by PR number. Returns the number of rows actually changed. */
export async function setProposalStatus(
  env: Env,
  prNumber: number,
  status: ProposalStatus,
): Promise<number> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/agent_proposals?pr_number=eq.${prNumber}`, {
    method: "PATCH",
    headers: restHeaders(env, { Prefer: "return=representation" }),
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    throw new Error(`set-proposal-status PATCH → ${res.status}: ${await res.text()}`);
  }
  // PostgREST returns 204 with an empty body when Prefer:return=minimal wins; guard for that.
  const text = await res.text();
  if (!text) return 0;
  return (JSON.parse(text) as unknown[]).length;
}

// ─── read ─────────────────────────────────────────────────────────────────────────

/** Open proposals, optionally narrowed to one agent (donor or proposed slug). */
export async function listOpenProposals(env: Env, agentSlug?: string | null): Promise<ProposalRow[]> {
  const filter = agentSlug ? `&agent_slug=eq.${encodeURIComponent(agentSlug)}` : "";
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/agent_proposals?status=eq.open${filter}&order=created_at.desc`,
    { headers: restHeaders(env) },
  );
  if (!res.ok) {
    throw new Error(`list-proposals GET → ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as ProposalRow[];
}

// ─── reconcile (pull-based; no webhook) ───────────────────────────────────────────

export interface PrState {
  state: "open" | "closed";
  merged: boolean;
}

/** Map a GitHub PR state to the proposal status it implies. `null` = still open, leave it. */
export function statusForPrState(pr: PrState): ProposalStatus | null {
  if (pr.merged) return "merged";
  if (pr.state === "closed") return "closed";
  return null;
}

export interface ReconcileResult {
  prNumber: number;
  status: ProposalStatus;
  changed: boolean;
}

/**
 * Ask GitHub about one recorded PR and move the proposal out of `open` if the PR is finished.
 *
 * Deliberately pull-based: the audit asked for no webhook endpoint, and a proposal is checked
 * exactly when someone is looking at it. `GET /pulls/{n}` is a read — this never merges anything.
 *
 * For a merged agent-kind proposal there is nothing to "activate": the PR's own seed migration
 * inserts the agents row with the default lifecycle 'active'. `activateAgentIfNeeded` exists only
 * as a repair for rows a pre-fix draft left stranded in 'proposed'.
 */
export async function reconcileProposal(
  env: Env,
  row: ProposalRow,
  gh: GhAppFetch = realGhAppFetch,
): Promise<ReconcileResult> {
  const pr = await gh<PrState>(env, `/repos/${REPO}/pulls/${row.pr_number}`);
  const next = statusForPrState(pr);
  if (!next) return { prNumber: row.pr_number, status: "open", changed: false };

  await setProposalStatus(env, row.pr_number, next);
  if (next === "merged" && row.kind === "agent" && row.agent_slug) {
    await activateAgentIfNeeded(env, row.agent_slug).catch((err) => {
      console.error("[tier2] post-merge agent activation failed:", err);
    });
  }
  return { prNumber: row.pr_number, status: next, changed: true };
}

/**
 * Belt-and-braces repair: if an agents row is somehow sitting in 'proposed', put it back to
 * 'active'. Nothing writes 'proposed' any more, so this only ever heals legacy rows.
 */
export async function activateAgentIfNeeded(env: Env, slug: string): Promise<void> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/agents?slug=eq.${encodeURIComponent(slug)}&lifecycle=eq.proposed`,
    {
      method: "PATCH",
      headers: restHeaders(env, { Prefer: "return=minimal" }),
      body: JSON.stringify({ lifecycle: "active", updated_at: new Date().toISOString() }),
    },
  );
  if (!res.ok) {
    throw new Error(`activate-agent PATCH → ${res.status}: ${await res.text()}`);
  }
}

/** Reconcile every open proposal (optionally for one agent) and return the post-reconcile list. */
export async function reconcileOpenProposals(
  env: Env,
  agentSlug: string | null,
  gh: GhAppFetch = realGhAppFetch,
): Promise<ProposalRow[]> {
  const open = await listOpenProposals(env, agentSlug);
  for (const row of open) {
    try {
      await reconcileProposal(env, row, gh);
    } catch (err) {
      // A PR we cannot read (deleted, or the App lost access) must not break the page.
      console.error(`[tier2] reconcile of PR #${row.pr_number} failed:`, err);
    }
  }
  return listOpenProposals(env, agentSlug);
}
