// Tier 2 agent builder (#67): the ops-only draft endpoint.
//
// POST /api/agent-builder/tier2/draft — an ops user proposes a NEW capability. A proposal is one
// of three KINDS, all of which produce a file set and open a human-merge-gated PR against
// LumitureLabs/LumiAgents (the app only DRAFTS; an ops engineer reviews + merges; there is NO
// auto-merge and NO merge call anywhere):
//   - "orchestration" (Build 1): a new orchestration/tool for an existing agent.
//   - "table"         (Build 2): a new forward-only domain table (+ RLS) in the orchestration schema.
//   - "agent"         (Build 2): a scaffold for a new dedicated-Worker agent.
// Every kind goes through the identical openPR + markProposed path and reuses Build 1's App-secret
// 503 guard so unprovisioned envs (CI) degrade gracefully instead of crashing.

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

const REPO = "LumitureLabs/LumiAgents";
type DraftKind = "orchestration" | "table" | "agent";

// ─── PR bodies (per kind) ──────────────────────────────────────────────────────────

const MERGE_NOTE =
  `### ⚠️ This PR is machine-drafted — review before merge\n` +
  `It was **not executed** during generation. Nothing ships until an ops engineer reviews this ` +
  `diff and merges. There is no auto-merge; the app cannot merge.\n`;

function orchestrationPrBody(spec: OrchestrationSpec): string {
  return (
    `## Tier 2 agent builder proposal (#67) — new orchestration\n\n` +
    `An ops user proposed a new capability for **${spec.agentSlug}**: \`${orchestrationName(spec)}\`.\n\n` +
    `> ${spec.description}\n\n` +
    `**Intent:** ${spec.intent}\n\n` +
    MERGE_NOTE +
    `\nOn merge, CI + \`supabase db push\` register the orchestration and the agent leaves the \`proposed\` state.\n`
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
    `\nOn merge, \`supabase db push\` applies the migration.\n`
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
    `\n${MERGE_NOTE}`
  );
}

// ─── mark-proposed (best-effort; never throws into the response) ────────────────────

async function markProposed(env: Env, agentSlug: string, pr: OpenPrResult): Promise<void> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/agents?slug=eq.${encodeURIComponent(agentSlug)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Profile": "orchestration",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        lifecycle: "proposed",
        pending_pr_url: pr.htmlUrl,
        pending_pr_number: pr.number,
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`mark-proposed PATCH agents → ${res.status}: ${await res.text()}`);
  }
}

// ─── best-effort context lookups (never block a draft) ──────────────────────────────

/** Existing orchestration-schema table names, derived from `*_create_<name>.sql` migration files. */
async function existingTableNames(env: Env, gh: GhAppFetch): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const dir = await gh<{ name: string }[]>(env, `/repos/${REPO}/contents/supabase/migrations?ref=main`);
    for (const e of dir) {
      const m = /_create_([a-z0-9_]+)\.sql$/.exec(e.name);
      if (m) names.add(m[1] as string);
    }
  } catch {
    // best-effort: on failure fall back to CREATE TABLE IF NOT EXISTS + human review.
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
  agentSlug: string | null; // when set, mark that agent 'proposed' after the PR opens
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
  };
}

async function planTable(env: Env, body: unknown, shortId: string): Promise<DraftPlan> {
  const spec = body as TableSpec;
  const ctx = { existingTableNames: await existingTableNames(env, ghAppFetch) };
  const pkg = generateTablePackage(spec, ctx);
  return {
    files: pkg.files,
    branch: namespacedBranch("table", spec.tableName, shortId),
    title: `feat(db): add orchestration.${spec.tableName} table (agent builder, #67)`,
    body: tablePrBody(spec),
    agentSlug: null,
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

    // Mark the agent 'proposed' + record the PR (best-effort; the PR is already open). Only kinds
    // tied to an agent do this; a table has no agent to mark.
    if (plan.agentSlug) {
      await markProposed(env, plan.agentSlug, pr).catch((err) => {
        console.error("[tier2] mark-proposed failed (PR is still open):", err);
      });
    }

    return json({ prUrl: pr.htmlUrl, prNumber: pr.number, branch: pr.branch, kind }, 201);
  }

  return null;
}
