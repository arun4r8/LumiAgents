// Tier 2 agent builder (#67): the ops-only draft endpoint + the proposal lifecycle.
//
// POST /api/agent-builder/tier2/draft — an ops user proposes a NEW capability. A proposal is one
// of three KINDS, all of which produce a file set and open a human-merge-gated PR against
// LumitureLabs/LumiAgents (the app only DRAFTS; an ops engineer reviews + merges; there is NO
// auto-merge and NO merge call anywhere):
//   - "orchestration" (Build 1): a new orchestration/tool for an existing agent.
//   - "table"         (Build 2): a new forward-only domain table (+ RLS) in the orchestration schema.
//   - "agent"         (Build 2): a scaffold for a new dedicated-Worker agent.
// Every kind goes through the identical openPR + recordProposal path and reuses Build 1's
// App-secret 503 guard so unprovisioned envs (CI) degrade gracefully instead of crashing.
//
// GET  /api/agent-builder/tier2/proposals?agentSlug=…  — ops: list pending proposals, reconciling
//      each against its GitHub PR first (merged / closed-unmerged both clear it). Pull-based by
//      design: the audit explicitly ruled out a merge webhook.
// POST /api/agent-builder/tier2/proposals/cancel       — ops: abandon a pending proposal.
//
// What a proposal does NOT do (audit #67): it does not touch orchestration.agents. Recording a
// pending PR used to set the DONOR agent's `lifecycle='proposed'`, and the agents list shows
// non-ops callers only `lifecycle='active'` — so proposing a tool for Cleo hid Cleo from every
// enduser. Proposals now live in orchestration.agent_proposals and change nothing an enduser sees.

import type { Env } from "../types";
import { json, requireOpsToken, rateLimited } from "./helpers";
import { requireAppSecrets, ghAppFetch, type GhAppFetch } from "../integrations/github/app-auth";
import {
  generateOrchestrationPackage,
  registryValidationContext,
  validateSpec,
  Tier2ValidationError,
  orchestrationName,
  type OrchestrationSpec,
} from "../agent-builder/tier2/generate";
import { generateTablePackage, type TableSpec } from "../agent-builder/tier2/generate-table";
import { generateAgentPackage, type AgentSpec } from "../agent-builder/tier2/generate-agent";
import { openPR, namespacedBranch, deterministicShortId, type OpenPrResult, type PrFile } from "../agent-builder/tier2/pr";
import {
  listOpenProposals,
  reconcileOpenProposals,
  recordProposal,
  setProposalStatus,
  type ProposalKind,
} from "../agent-builder/tier2/proposals";

const REPO = "LumitureLabs/LumiAgents";
type DraftKind = ProposalKind;

// ─── PR bodies (per kind) ──────────────────────────────────────────────────────────

const MERGE_NOTE =
  `### ⚠️ This PR is machine-drafted — review before merge\n` +
  `It was **not executed** during generation. Nothing ships until an ops engineer reviews this ` +
  `diff and merges. There is no auto-merge and no code path in this repo calls GitHub's merge API.\n`;

// Since #121 a merge does NOT reach customers. Say so in every machine-drafted PR: this is the
// most safety-critical sentence a reviewer reads, and the old bodies described the pre-#121
// pipeline in which merging deployed production directly.
const PIPELINE_NOTE =
  `\n### Where merging sends this\n` +
  `Merging to \`main\` deploys **staging only** (\`deploy-staging.yml\`: staging Supabase migrations, ` +
  `\`*-staging\` Workers, staging dashboard, smoke test). **Production is a separate, manual promotion** ` +
  `— a human runs *Deploy Worker (PRODUCTION — manual)* (and *Deploy Dashboard (PRODUCTION — manual)*, ` +
  `if the dashboard changed) from the Actions tab. See \`docs/environments.md\`.\n`;

function orchestrationPrBody(spec: OrchestrationSpec): string {
  return (
    `## Tier 2 agent builder proposal (#67) — new orchestration\n\n` +
    `An ops user proposed a new capability for **${spec.agentSlug}**: \`${orchestrationName(spec)}\`.\n\n` +
    `> ${spec.description}\n\n` +
    `**Intent:** ${spec.intent}\n\n` +
    MERGE_NOTE +
    PIPELINE_NOTE +
    `\nOn merge, staging CI + \`supabase db push\` register the orchestration on staging, and the ` +
    `dashboard marks the proposal resolved the next time an ops user looks at the agent. ` +
    `**${spec.agentSlug} stays live and visible to end users throughout** — a pending proposal ` +
    `never changes an agent's lifecycle.\n`
  );
}

function tablePrBody(spec: TableSpec): string {
  return (
    `## Tier 2 agent builder proposal (#67) — new data table\n\n` +
    `An ops user proposed a new domain table: \`orchestration.${spec.tableName}\` ` +
    `(${spec.columns.length} column${spec.columns.length === 1 ? "" : "s"}, ` +
    `enduser-readable: ${spec.enduserReadable ? "yes" : "no"}).\n\n` +
    `The migration is **forward-only**: \`CREATE TABLE IF NOT EXISTS\` + RLS + an ops-all policy` +
    `${spec.enduserReadable ? " + an enduser read policy" : ""} + GRANTs. No DROP/TRUNCATE/DELETE and ` +
    `no destructive ALTER (the sole ALTER enables RLS). The rollback appears only as a comment.\n\n` +
    MERGE_NOTE +
    PIPELINE_NOTE +
    `\nOn merge, \`supabase db push\` applies the migration **to the staging project**. It reaches ` +
    `production only when a human runs the manual production workflow.\n`
  );
}

function agentPrBody(spec: AgentSpec, secretsNeeded: string[]): string {
  const secretsBlock =
    secretsNeeded.length > 0
      ? `\n**Secrets this agent will need (NAMES only — provision out-of-band via \`wrangler secret put\`):**\n` +
        secretsNeeded.map((s) => `- \`${s}\``).join("\n") +
        `\n`
      : `\nNo extra secrets declared beyond \`ANTHROPIC_API_KEY\`.\n`;
  return (
    `## Tier 2 agent builder proposal (#67) — new dedicated-Worker agent\n\n` +
    `An ops user proposed a new agent: **${spec.displayName}** (\`${spec.slug}\`), wired to existing ` +
    `orchestrations only: ${spec.tools.map((t) => `\`${t}\``).join(", ")}.\n\n` +
    `This is a **scaffold** a human completes (persona polish, per-Worker deploy config, secret ` +
    `provisioning). Tools wire to EXISTING orchestrations only; no secret VALUE is inlined anywhere.\n` +
    secretsBlock +
    `\nThe new \`runtime/workers/${spec.slug}/wrangler.toml\` carries both a production and an ` +
    `\`[env.staging]\` config, and both deploy workflows discover agent Workers by globbing ` +
    `\`runtime/workers/*/wrangler.toml\` — so no workflow edit is needed for this agent to deploy.\n` +
    `\n${MERGE_NOTE}` +
    PIPELINE_NOTE
  );
}

// ─── best-effort context lookups (never block a draft) ──────────────────────────────

/**
 * Table names that already exist in the `orchestration` schema, read from the REAL schema via the
 * `public.list_orchestration_tables()` RPC (service role, the same REST pattern as every other
 * runtime DB read).
 *
 * The previous implementation derived names from `*_create_<name>.sql` migration FILENAMES — a
 * convention none of the repo's migrations use — so the collision check never fired once, and a
 * proposal for a table named `agents` or `runs` produced a no-op `CREATE TABLE IF NOT EXISTS`
 * followed by a `CREATE POLICY` that errors, failing `supabase db push` for the whole project.
 */
export async function existingTableNames(env: Env): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/list_orchestration_tables`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: "{}",
    });
    if (res.ok) {
      for (const r of (await res.json()) as { table_name: string }[]) {
        if (r?.table_name) names.add(r.table_name);
      }
    } else {
      console.error(`[tier2] list_orchestration_tables → ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    // best-effort: on failure fall back to CREATE TABLE IF NOT EXISTS + human review.
    console.error("[tier2] list_orchestration_tables failed:", err);
  }
  return names;
}

/** Catalog agent slugs (config + code), so a new agent slug cannot collide with an existing one. */
async function catalogAgentSlugs(env: Env): Promise<Set<string>> {
  const slugs = new Set<string>();
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/agents?select=slug`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Accept-Profile": "orchestration",
      },
    });
    if (res.ok) {
      for (const r of (await res.json()) as { slug: string }[]) slugs.add(r.slug);
    }
  } catch {
    // best-effort: registry-derived code slugs still cover the dedicated agents.
  }
  return slugs;
}

// ─── per-kind draft plan ────────────────────────────────────────────────────────────

interface DraftPlan {
  files: PrFile[];
  branch: string;
  title: string;
  body: string;
  /** Donor agent (orchestration kind) or the proposed agent's slug (agent kind); null for a table. */
  agentSlug: string | null;
  /** What is being proposed — capability slug / table name / agent slug. */
  target: string;
}

async function planOrchestration(env: Env, body: unknown, shortId: string): Promise<DraftPlan> {
  const spec = body as OrchestrationSpec;
  const errors = validateSpec(spec, registryValidationContext());
  if (errors.length > 0) throw new Tier2ValidationError(errors);
  const pkg = await generateOrchestrationPackage(env, spec);
  return {
    files: pkg.files,
    branch: namespacedBranch(spec.agentSlug, spec.capabilitySlug, shortId),
    title: `feat(${spec.agentSlug}): add ${orchestrationName(spec)} capability (agent builder, #67)`,
    body: orchestrationPrBody(spec),
    agentSlug: spec.agentSlug,
    target: orchestrationName(spec),
  };
}

async function planTable(env: Env, body: unknown, shortId: string): Promise<DraftPlan> {
  const spec = body as TableSpec;
  const ctx = { existingTableNames: await existingTableNames(env) };
  const pkg = generateTablePackage(spec, ctx);
  return {
    files: pkg.files,
    branch: namespacedBranch("table", spec.tableName, shortId),
    title: `feat(db): add orchestration.${spec.tableName} table (agent builder, #67)`,
    body: tablePrBody(spec),
    agentSlug: null,
    target: spec.tableName,
  };
}

async function planAgent(env: Env, body: unknown, shortId: string): Promise<DraftPlan> {
  const spec = body as AgentSpec;
  const extraAgentSlugs = await catalogAgentSlugs(env);
  const pkg = await generateAgentPackage(env, spec, { extraAgentSlugs });
  return {
    files: pkg.files,
    branch: namespacedBranch("agent", spec.slug, shortId),
    title: `feat(agents): scaffold new dedicated-Worker agent ${spec.slug} (agent builder, #67)`,
    body: agentPrBody(spec, pkg.secretsNeeded),
    agentSlug: spec.slug,
    target: spec.slug,
  };
}

// ─── the route ──────────────────────────────────────────────────────────────────────

export async function handleAgentBuilder(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;

  if (pathname === "/api/agent-builder/tier2/draft" && request.method === "POST") {
    return handleDraft(request, env);
  }
  if (pathname === "/api/agent-builder/tier2/proposals" && request.method === "GET") {
    return handleListProposals(request, env, url);
  }
  if (pathname === "/api/agent-builder/tier2/proposals/cancel" && request.method === "POST") {
    return handleCancelProposal(request, env);
  }

  return null;
}

// ─── POST /draft ────────────────────────────────────────────────────────────────────

async function handleDraft(request: Request, env: Env): Promise<Response> {
  // Ops-only, defended at the layer that holds the GitHub App credential.
  const auth = await requireOpsToken(request, env);
  if (auth instanceof Response) return auth;

  // Rate-limit: cap drafts per ops user to prevent PR-bombing (design §3b.2 R5).
  const rl = await rateLimited(env, auth.userId, "agent-builder-draft", 5, 3600);
  if (rl) return rl;

  // Guard the out-of-band App secrets: absent in CI / not-yet-provisioned → 503, never a crash.
  try {
    requireAppSecrets(env);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "GitHub App not configured" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const kind: DraftKind = (body.kind as DraftKind) ?? "orchestration";
  if (kind !== "orchestration" && kind !== "table" && kind !== "agent") {
    return json({ error: `Unknown draft kind "${String(kind)}" (expected orchestration | table | agent).` }, 400);
  }

  // Deterministic short id from the kind + spec, so a re-draft reuses the same branch namespace.
  // openPR now recovers when that branch already exists from a draft that died mid-flight.
  const shortId = await deterministicShortId(JSON.stringify({ kind, body }));

  // Generate the file set for the requested kind (LLM output, if any, is a proposal never executed).
  let plan: DraftPlan;
  try {
    if (kind === "orchestration") plan = await planOrchestration(env, body, shortId);
    else if (kind === "table") plan = await planTable(env, body, shortId);
    else plan = await planAgent(env, body, shortId);
  } catch (err) {
    if (err instanceof Tier2ValidationError) {
      return json({ error: "Invalid capability spec", details: err.details }, 400);
    }
    console.error(`[tier2] ${kind} generation failed:`, err);
    return json({ error: `Codegen failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }

  // Open the human-merge-gated PR (never merged here).
  let pr: OpenPrResult;
  try {
    pr = await openPR(env, { branch: plan.branch, files: plan.files, title: plan.title, body: plan.body });
  } catch (err) {
    console.error("[tier2] openPR failed:", err);
    return json({ error: `Opening the PR failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }

  // Record the pending proposal (best-effort; the PR is already open). This writes ONLY to
  // agent_proposals — the donor agent's catalog row, and therefore its visibility to endusers, is
  // deliberately untouched. It works for every kind, including "agent", whose catalog row does not
  // exist until the PR merges (the old markProposed PATCH matched 0 rows and silently returned 204).
  await recordProposal(env, {
    kind,
    agentSlug: plan.agentSlug,
    target: plan.target,
    prNumber: pr.number,
    prUrl: pr.htmlUrl,
    branch: pr.branch,
    createdBy: auth.userId,
  }).catch((err) => {
    console.error("[tier2] record-proposal failed (PR is still open):", err);
  });

  return json({ prUrl: pr.htmlUrl, prNumber: pr.number, branch: pr.branch, kind }, 201);
}

// ─── GET /proposals ─────────────────────────────────────────────────────────────────

/**
 * List pending proposals, reconciling each against GitHub first so a merged or closed PR clears
 * itself. Pull-based on purpose — there is no merge webhook and none is wanted. When the App
 * secrets are absent (CI, staging) reconciliation is skipped and the stored rows are returned
 * unchanged, so the surface degrades instead of erroring.
 */
async function handleListProposals(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = await requireOpsToken(request, env);
  if (auth instanceof Response) return auth;

  const agentSlug = url.searchParams.get("agentSlug");
  let canReconcile = url.searchParams.get("reconcile") !== "0";
  if (canReconcile) {
    try {
      requireAppSecrets(env);
    } catch {
      canReconcile = false;
    }
  }

  try {
    const proposals = canReconcile
      ? await reconcileOpenProposals(env, agentSlug, ghAppFetch as GhAppFetch)
      : await listOpenProposals(env, agentSlug);
    return json({ proposals, reconciled: canReconcile });
  } catch (err) {
    console.error("[tier2] listing proposals failed:", err);
    return json({ error: `Could not list proposals: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
}

// ─── POST /proposals/cancel ─────────────────────────────────────────────────────────

/**
 * Ops abandons a pending proposal. Always clears the local record; also best-effort CLOSES the PR
 * on GitHub (`PATCH /pulls/{n}` with state=closed — a close, never a merge) so an abandoned draft
 * does not linger. Failing to close never fails the cancel.
 */
async function handleCancelProposal(request: Request, env: Env): Promise<Response> {
  const auth = await requireOpsToken(request, env);
  if (auth instanceof Response) return auth;

  let body: { prNumber?: number; closePr?: boolean };
  try {
    body = (await request.json()) as { prNumber?: number; closePr?: boolean };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const prNumber = Number(body.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return json({ error: "prNumber (a positive integer) is required." }, 400);
  }

  let changed: number;
  try {
    changed = await setProposalStatus(env, prNumber, "cancelled");
  } catch (err) {
    console.error("[tier2] cancel proposal failed:", err);
    return json({ error: `Could not cancel the proposal: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
  if (changed === 0) {
    return json({ error: `No proposal recorded for PR #${prNumber}.` }, 404);
  }

  let prClosed = false;
  if (body.closePr !== false) {
    try {
      requireAppSecrets(env);
      await ghAppFetch(env, `/repos/${REPO}/pulls/${prNumber}`, { method: "PATCH", body: { state: "closed" } });
      prClosed = true;
    } catch (err) {
      console.error(`[tier2] could not close PR #${prNumber} (the proposal is cancelled anyway):`, err);
    }
  }

  return json({ ok: true, prNumber, prClosed });
}
