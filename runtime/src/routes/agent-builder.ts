// Tier 2 agent builder (#67): the ops-only draft endpoint.
//
// POST /api/agent-builder/tier2/draft — an ops user proposes a NEW capability (a new
// orchestration/tool) for an existing agent. The runtime generates the package, opens a
// human-merge-gated PR against LumitureLabs/LumiAgents, marks the agent 'proposed', and records
// the pending PR. It NEVER merges — the human merge is the entire governance gate.

import type { Env } from "../types";
import { json, requireOpsToken, rateLimited } from "./helpers";
import { requireAppSecrets } from "../integrations/github/app-auth";
import {
  generateOrchestrationPackage,
  registryValidationContext,
  validateSpec,
  Tier2ValidationError,
  orchestrationName,
  type OrchestrationSpec,
} from "../agent-builder/tier2/generate";
import { openPR, namespacedBranch, deterministicShortId, type OpenPrResult } from "../agent-builder/tier2/pr";

function prBody(spec: OrchestrationSpec): string {
  return (
    `## Tier 2 agent builder proposal (#67)\n\n` +
    `An ops user proposed a new capability for **${spec.agentSlug}**: \`${orchestrationName(spec)}\`.\n\n` +
    `> ${spec.description}\n\n` +
    `**Intent:** ${spec.intent}\n\n` +
    `### ⚠️ This PR is machine-drafted — review before merge\n` +
    `The \`run()\` body in the new \`definition.ts\` is an **LLM proposal** and has **not been executed**. ` +
    `Nothing ships until an ops engineer reviews this diff and merges. There is no auto-merge; the app cannot merge.\n\n` +
    `On merge, CI + \`supabase db push\` register the orchestration and the agent leaves the \`proposed\` state.\n`
  );
}

/**
 * Best-effort: mark the agent 'proposed' and record the pending PR (service_role, bypasses RLS).
 * Never throws into the response path — a catalog write failure must not fail an already-open PR.
 */
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

    let spec: OrchestrationSpec;
    try {
      spec = (await request.json()) as OrchestrationSpec;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    // Validate before generating (refuse otherwise).
    const errors = validateSpec(spec, registryValidationContext());
    if (errors.length > 0) return json({ error: "Invalid capability spec", details: errors }, 400);

    // Generate the package (LLM run() body is a proposal, never executed here).
    let pkg;
    try {
      pkg = await generateOrchestrationPackage(env, spec);
    } catch (err) {
      if (err instanceof Tier2ValidationError) {
        return json({ error: "Invalid capability spec", details: err.details }, 400);
      }
      console.error("[tier2] generation failed:", err);
      return json({ error: `Codegen failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }

    // Deterministic branch from the spec, so a re-draft reuses the same namespace.
    const shortId = await deterministicShortId(JSON.stringify(spec));
    const branch = namespacedBranch(spec.agentSlug, spec.capabilitySlug, shortId);
    const title = `feat(${spec.agentSlug}): add ${orchestrationName(spec)} capability (agent builder, #67)`;

    let pr: OpenPrResult;
    try {
      pr = await openPR(env, { branch, files: pkg.files, title, body: prBody(spec) });
    } catch (err) {
      console.error("[tier2] openPR failed:", err);
      return json({ error: `Opening the PR failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }

    // Mark the agent 'proposed' + record the PR (best-effort; the PR is already open).
    await markProposed(env, spec.agentSlug, pr).catch((err) => {
      console.error("[tier2] mark-proposed failed (PR is still open):", err);
    });

    return json({ prUrl: pr.htmlUrl, prNumber: pr.number, branch: pr.branch }, 201);
  }

  return null;
}
