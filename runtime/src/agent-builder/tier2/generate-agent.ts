// Tier 2 agent builder (#67) — Build 2: new dedicated-Worker agent codegen (a SCAFFOLD).
//
// From a spec { slug, displayName, card, persona, tools:[orchestrationName] } this clone-and-fills
// the wiring for a brand-new dedicated-Worker agent, mirroring the six hand-built agents
// (agents/<slug>/index.ts + the agent-worker factory + registry/binding wiring + the agents
// catalog seed, source='code'). It is explicitly a SCAFFOLD a human completes: tools are wired to
// EXISTING orchestrations only (never new/unknown ones), secrets are referenced by NAME only
// (never inlined — the ops runbook provisions values), and per-Worker deploy config is left for a
// human. Everything ships as a PR an ops engineer reviews + merges; nothing is executed here and
// there is no auto-merge anywhere.

import type { Env } from "../../types";
import type { PrFile } from "./pr";
import { defaultTimestamp, registryValidationContext } from "./generate";
import { Tier2ValidationError } from "./errors";
import { ghAppFetch as realGhAppFetch, type GhAppFetch } from "../../integrations/github/app-auth";
import { assertNoDestructiveSql, assertNoInlineSecrets } from "./guards";

const REPO = "LumitureLabs/LumiAgents";

export interface AgentCard {
  emoji?: string;
  category?: string;
  description?: string;
  suggestedPrompts?: string[];
}

/** The new-agent proposal an ops user submits. */
export interface AgentSpec {
  slug: string; // kebab-case; the agent's identity everywhere (routing, worker, catalog)
  displayName: string;
  card: AgentCard;
  persona: string; // becomes the AgentDefinition.systemPrompt
  tools: string[]; // orchestration names — MUST already exist; wired into the toolMap
  secrets?: string[]; // NAMES only (SCREAMING_SNAKE); listed in the PR body + manifest, never valued
}

export interface AgentValidationContext {
  existingAgentSlugs: Set<string>;
  existingOrchestrationNames: Set<string>;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Validate a new-agent spec (pure, no network, fully testable). Returns the list of problems
 * ([] when valid): kebab slug unique against code + catalog agents; a display name and persona;
 * at least one tool, and EVERY tool an orchestration that already exists (never a new/unknown one);
 * any declared secret a NAME, never a value.
 */
export function validateAgentSpec(spec: AgentSpec, ctx: AgentValidationContext): string[] {
  const errors: string[] = [];
  if (!spec || typeof spec !== "object") return ["spec must be an object."];

  if (!spec.slug || !KEBAB.test(spec.slug)) {
    errors.push(`slug "${spec.slug ?? ""}" must be kebab-case (lowercase letters, digits, hyphens).`);
  } else if (ctx.existingAgentSlugs.has(spec.slug)) {
    errors.push(`Agent "${spec.slug}" already exists (code or catalog); choose a new slug.`);
  }
  if (!spec.displayName || !spec.displayName.trim()) errors.push("displayName is required.");
  if (!spec.persona || !spec.persona.trim()) errors.push("persona is required.");

  if (!Array.isArray(spec.tools) || spec.tools.length === 0) {
    errors.push("tools must list at least one existing orchestration.");
  } else {
    const seen = new Set<string>();
    for (const name of spec.tools) {
      if (seen.has(name)) errors.push(`duplicate tool "${name}".`);
      seen.add(name);
      if (!ctx.existingOrchestrationNames.has(name)) {
        errors.push(`tool "${name}" is not an existing orchestration. A new agent may only wire EXISTING orchestrations.`);
      }
    }
  }

  if (spec.secrets) {
    if (!Array.isArray(spec.secrets)) {
      errors.push("secrets must be an array of NAMES.");
    } else {
      for (const s of spec.secrets) {
        if (!SECRET_NAME.test(s ?? "")) errors.push(`secret "${s}" must be a NAME (SCREAMING_SNAKE_CASE), never a value.`);
      }
    }
  }
  return errors;
}

/** Build the validation context from the live registry, plus any extra (catalog) agent slugs. */
export function agentValidationContext(extraAgentSlugs: Iterable<string> = []): AgentValidationContext {
  const base = registryValidationContext();
  const slugs = new Set(base.existingAgentSlugs);
  for (const s of extraAgentSlugs) slugs.add(s);
  return { existingAgentSlugs: slugs, existingOrchestrationNames: base.existingOrchestrationNames };
}

// ─── Naming helpers (pure) ────────────────────────────────────────────────────────

/** kebab → camelCase identifier, e.g. "sales-scout" → "salesScout". */
export function camelIdentifier(slug: string): string {
  const parts = slug.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
    .join("");
}

/** kebab → SCREAMING_SNAKE, e.g. "sales-scout" → "SALES_SCOUT". */
export function screamingSnake(slug: string): string {
  return slug.replace(/-/g, "_").toUpperCase();
}

/** The Env key for the agent's Service Binding, e.g. "SALES_SCOUT_WORKER". */
export function workerBindingConst(slug: string): string {
  return `${screamingSnake(slug)}_WORKER`;
}

/** A tool name derived from an orchestration name: "dewey/knowledge-search" → "knowledge_search". */
export function toolNameFor(orchestrationName: string): string {
  const tail = orchestrationName.includes("/") ? orchestrationName.split("/").slice(1).join("/") : orchestrationName;
  return tail.replace(/-/g, "_");
}

// ─── Template literal / SQL escaping (pure) ────────────────────────────────────────

function escapeForTemplateLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const TS_HEADER =
  "// ⚠️  MACHINE-DRAFTED by the LumiAgents Tier 2 agent builder (#67, Build 2) — REVIEW BEFORE MERGE.\n" +
  "// This is a SCAFFOLD for a new dedicated-Worker agent. It was NOT executed during generation.\n" +
  "// A human completes it (persona polish, per-Worker deploy config, any secret provisioning by\n" +
  "// NAME via the ops runbook) and reviews every line before merge. Tools wire to EXISTING\n" +
  "// orchestrations only. See docs/agent-builder-tier2-design.md.\n";

// ─── New-file renderers (pure) ─────────────────────────────────────────────────────

/** Render agents/<slug>/index.ts — the AgentDefinition, persona from spec, tools wired to existing orchestrations. */
export function renderAgentIndex(spec: AgentSpec): string {
  const ident = camelIdentifier(spec.slug);
  const toolEntries = spec.tools
    .map((orch) => {
      const tool = toolNameFor(orch);
      return (
        `    {\n` +
        `      name: ${JSON.stringify(tool)},\n` +
        `      description: ${JSON.stringify(`Runs the ${orch} orchestration. TODO(review): sharpen this description.`)},\n` +
        `      inputSchema: { type: "object", properties: {} }, // TODO(review): declare the real inputs\n` +
        `    },`
      );
    })
    .join("\n");
  const toolMapEntries = spec.tools
    .map((orch) => `    ${toolNameFor(orch)}: { orchestration: ${JSON.stringify(orch)} },`)
    .join("\n");

  return (
    `${TS_HEADER}` +
    `import type { AgentDefinition } from "../types";\n\n` +
    `export const ${ident}: AgentDefinition = {\n` +
    `  slug: ${JSON.stringify(spec.slug)},\n` +
    `  displayName: ${JSON.stringify(spec.displayName)},\n` +
    `  systemPrompt: \`${escapeForTemplateLiteral(spec.persona)}\`,\n` +
    `  tools: [\n${toolEntries}\n  ],\n` +
    `  toolMap: {\n${toolMapEntries}\n  },\n` +
    `};\n`
  );
}

/** Render runtime/src/workers/<slug>.ts — the tiny agent-worker entry-point. */
export function renderWorkerEntry(spec: AgentSpec): PrFile {
  return {
    path: `runtime/src/workers/${spec.slug}.ts`,
    content:
      `${TS_HEADER}` +
      `import { makeAgentWorker } from "./agent-worker";\n` +
      `export default makeAgentWorker(${JSON.stringify(spec.slug)});\n`,
  };
}

/**
 * Render runtime/workers/<slug>/wrangler.toml — the per-Worker deploy config (a scaffold).
 *
 * Emits BOTH the production config and the `[env.staging]` twin, mirroring the six hand-built
 * agent Workers. Since #121 a merge deploys staging first, and both deploy workflows now discover
 * agent Worker configs by globbing `runtime/workers/*​/wrangler.toml` — so this file alone is what
 * makes the new agent deployable in both environments with no hand-editing of any workflow.
 */
export function renderWorkerWrangler(spec: AgentSpec): PrFile {
  const secretsComment = (spec.secrets ?? []).map((s) => `# ${s}`).join("\n");
  return {
    path: `runtime/workers/${spec.slug}/wrangler.toml`,
    content:
      `# MACHINE-DRAFTED (#67, Build 2) — REVIEW BEFORE MERGE. Scaffold per-Worker config.\n` +
      `# Both deploy workflows glob runtime/workers/*/wrangler.toml, so this Worker is picked up\n` +
      `# automatically (staging on merge, production on the manual promotion). No workflow edit needed.\n` +
      `name = "lumiagents-${spec.slug}"\n` +
      `main = "../../src/workers/${spec.slug}.ts"\n` +
      `compatibility_date = "2025-04-01"\n` +
      `compatibility_flags = ["nodejs_compat"]\n\n` +
      `[vars]\n` +
      `SUPABASE_URL = "https://cuaknazkpmwvnkmwtamp.supabase.co"\n` +
      `ENVIRONMENT = "production"\n\n` +
      `# Secrets (set via \`wrangler secret put --name lumiagents-${spec.slug}\`) — NAMES only, ops provisions values:\n` +
      `# ANTHROPIC_API_KEY\n` +
      (secretsComment ? `${secretsComment}\n` : "") +
      `\n[[services]]\n` +
      `binding = "RUNTIME_WORKER"\n` +
      `service = "lumiagents-runtime"\n\n` +
      `[dev]\n` +
      `# TODO(review): pick a port that does not collide with the other agent Workers.\n` +
      `port = 8800\n\n` +
      `# ---------------------------------------------------------------------------\n` +
      `# STAGING environment (#121). Purely additive; production config above is unchanged.\n` +
      `# SUPABASE_URL is a placeholder overridden by CI with\n` +
      `#   wrangler deploy --env staging --var SUPABASE_URL:$STAGING_SUPABASE_URL\n` +
      `# Secrets: wrangler secret put ANTHROPIC_API_KEY --config workers/${spec.slug}/wrangler.toml --env staging\n` +
      `# ---------------------------------------------------------------------------\n` +
      `[env.staging]\n` +
      `name = "lumiagents-${spec.slug}-staging"\n\n` +
      `[env.staging.vars]\n` +
      `SUPABASE_URL = "https://STAGING-PROJECT-REF.supabase.co"  # overridden by CI (--var)\n` +
      `ENVIRONMENT = "staging"\n\n` +
      `[[env.staging.services]]\n` +
      `binding = "RUNTIME_WORKER"\n` +
      `service = "lumiagents-runtime-staging"\n`,
  };
}

/** Render the seed migration adding the agents-catalog row (source='code'). Forward-only INSERT. */
export function renderAgentSeedMigration(spec: AgentSpec, timestamp: string): PrFile {
  const c = spec.card ?? {};
  const cardParts: string[] = [];
  if (c.emoji) cardParts.push(`'emoji', ${sqlQuote(c.emoji)}`);
  if (c.category) cardParts.push(`'category', ${sqlQuote(c.category)}`);
  if (c.description) cardParts.push(`'description', ${sqlQuote(c.description)}`);
  if (Array.isArray(c.suggestedPrompts) && c.suggestedPrompts.length > 0) {
    cardParts.push(`'suggestedPrompts', jsonb_build_array(\n      ${c.suggestedPrompts.map(sqlQuote).join(",\n      ")})`);
  }
  const cardExpr = cardParts.length > 0 ? `jsonb_build_object(\n      ${cardParts.join(",\n      ")})` : "NULL";

  return {
    path: `supabase/migrations/${timestamp}_register_agent_${spec.slug.replace(/-/g, "_")}.sql`,
    content:
      `-- ⚠️  MACHINE-DRAFTED by the LumiAgents Tier 2 agent builder (#67, Build 2) — REVIEW BEFORE MERGE.\n` +
      `-- Registers the new dedicated-Worker agent "${spec.slug}" in the agents catalog (source='code').\n` +
      `-- Forward-only INSERT ... ON CONFLICT DO NOTHING (never DDL, never destructive). Since #121,\n` +
      `-- merging applies this to STAGING only (deploy-staging.yml). PRODUCTION is a separate MANUAL\n` +
      `-- promotion a human runs from the Actions tab. See docs/environments.md.\n` +
      `--\n` +
      `-- Rollback (manual, do not run automatically):\n` +
      `--   DELETE FROM orchestration.agents WHERE slug = '${spec.slug}';\n\n` +
      `INSERT INTO orchestration.agents (slug, display_name, source, card) VALUES\n` +
      `  (${sqlQuote(spec.slug)}, ${sqlQuote(spec.displayName)}, 'code', ${cardExpr})\n` +
      `ON CONFLICT (slug) DO NOTHING;\n`,
  };
}

/** Render agents/<slug>/agent.manifest.yaml — records the agent, its tools, and any required secret NAMES. */
export function renderAgentManifest(spec: AgentSpec): PrFile {
  const tools = spec.tools.map((t) => `    - ${t}`).join("\n");
  const secrets = (spec.secrets ?? []).map((s) => `    - ${s}`).join("\n");
  return {
    path: `agents/${spec.slug}/agent.manifest.yaml`,
    content:
      `# MACHINE-DRAFTED by the LumiAgents Tier 2 agent builder (#67, Build 2) — REVIEW BEFORE MERGE.\n` +
      `# Canonical manifest for the new dedicated-Worker agent "${spec.slug}". Scaffold — a human completes it.\n` +
      `agent: ${spec.slug}\n` +
      `displayName: ${JSON.stringify(spec.displayName)}\n` +
      `source: code\n` +
      `lifecycle: proposed   # live only after an ops engineer merges this PR\n` +
      `tools:\n` +
      `  enabled:\n${tools}\n` +
      `secrets:\n` +
      `  # NAMES only — ops provisions the values out-of-band via \`wrangler secret put\`. Never inline a value.\n` +
      `  required:${secrets ? `\n${secrets}` : " []"}\n`,
  };
}

// ─── Edits to existing wiring files (pure) ─────────────────────────────────────────

/** Add the agent's `import { ident } from "./slug";` + `"slug": ident,` entry to agents/index.ts. */
export function applyAgentsIndexEdit(current: string, spec: AgentSpec): string {
  const ident = camelIdentifier(spec.slug);
  const importLine = `import { ${ident} } from "./${spec.slug}";`;
  if (current.includes(importLine)) return current; // idempotent

  const lines = current.split("\n");
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import \{ \w+ \} from "\.\/[\w-]+";$/.test(lines[i] as string)) lastImport = i;
  }
  if (lastImport === -1) throw new Error("Could not locate the agent import block in agents/index.ts");
  lines.splice(lastImport + 1, 0, importLine);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as string).includes("export const AGENTS")) { start = i; break; }
  }
  if (start === -1) throw new Error("Could not locate the AGENTS record in agents/index.ts");
  let close = -1;
  for (let i = start; i < lines.length; i++) {
    if ((lines[i] as string).trim() === "};") { close = i; break; }
  }
  if (close === -1) throw new Error("Could not locate the AGENTS record terminator in agents/index.ts");
  lines.splice(close, 0, `  ${JSON.stringify(spec.slug)}: ${ident},`);
  return lines.join("\n");
}

/** Add the slug to the AgentSlug union in runtime/src/agents/agent-chat.ts. */
export function applyAgentSlugUnionEdit(current: string, spec: AgentSpec): string {
  if (new RegExp(`"${spec.slug}"`).test(current) && /export type AgentSlug =/.test(current)) {
    // Only skip if the slug already appears in the union line itself.
    const line = current.split("\n").find((l) => l.includes("export type AgentSlug ="));
    if (line && line.includes(`"${spec.slug}"`)) return current;
  }
  if (!/export type AgentSlug =/.test(current)) {
    throw new Error("Could not locate the AgentSlug union in agent-chat.ts");
  }
  return current.replace(/(export type AgentSlug =[^;]*)(;)/, `$1 | ${JSON.stringify(spec.slug)}$2`);
}

/** Add the slug → binding entry to AGENT_BINDINGS in runtime/src/routes/agents.ts. */
export function applyAgentBindingsEdit(current: string, spec: AgentSpec): string {
  const entry = `  ${JSON.stringify(spec.slug)}: ${JSON.stringify(workerBindingConst(spec.slug))},`;
  if (current.includes(entry)) return current; // idempotent

  const lines = current.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as string).includes("AGENT_BINDINGS")) { start = i; break; }
  }
  if (start === -1) throw new Error("Could not locate AGENT_BINDINGS in routes/agents.ts");
  let close = -1;
  for (let i = start; i < lines.length; i++) {
    if ((lines[i] as string).trim() === "};") { close = i; break; }
  }
  if (close === -1) throw new Error("Could not locate the AGENT_BINDINGS terminator in routes/agents.ts");
  lines.splice(close, 0, entry);
  return lines.join("\n");
}

/** Add the `<SLUG>_WORKER?: Fetcher;` field to the Env interface in runtime/src/types/index.ts. */
export function applyWorkerBindingTypeEdit(current: string, spec: AgentSpec): string {
  const field = `  ${workerBindingConst(spec.slug)}?: Fetcher;`;
  if (current.includes(field)) return current; // idempotent
  const anchor = "  MONEY_WORKER?: Fetcher;";
  if (!current.includes(anchor)) throw new Error("Could not locate the Service Binding block in types/index.ts");
  return current.replace(anchor, `${anchor}\n${field}`);
}

/**
 * Add the agent's Service Binding to the runtime wrangler.toml — for BOTH environments.
 *
 * wrangler does NOT inherit `services` into a named environment (docs/environments.md), so a
 * production-only `[[services]]` stanza leaves `lumiagents-runtime-staging` without the binding
 * and the staging runtime silently cannot reach the new agent Worker. The original edit inserted
 * only before the first `[triggers]` (production) — this adds the `[[env.staging.services]]`
 * twin too, anchored on `[env.staging.triggers]` (note: `"[triggers]"` as a substring does NOT
 * match `[env.staging.triggers]`, which is why the production anchor stays unambiguous).
 * Idempotent: a re-draft that finds both bindings already present is a no-op.
 */
export function applyWranglerServiceEdit(current: string, spec: AgentSpec): string {
  const binding = workerBindingConst(spec.slug);
  let out = current;

  // ── production ──
  const prodStanza =
    `[[services]]\n` +
    `binding = "${binding}"\n` +
    `service = "lumiagents-${spec.slug}"\n\n`;
  if (!new RegExp(`\\[\\[services\\]\\]\\s*\\nbinding = "${binding}"`).test(out)) {
    if (out.includes("[triggers]")) {
      out = out.replace("[triggers]", `${prodStanza}[triggers]`);
    } else {
      out = `${out.replace(/\n?$/, "\n")}\n${prodStanza}`;
    }
  }

  // ── staging twin ──
  const stagingStanza =
    `[[env.staging.services]]\n` +
    `binding = "${binding}"\n` +
    `service = "lumiagents-${spec.slug}-staging"\n\n`;
  if (!new RegExp(`\\[\\[env\\.staging\\.services\\]\\]\\s*\\nbinding = "${binding}"`).test(out)) {
    if (out.includes("[env.staging.triggers]")) {
      out = out.replace("[env.staging.triggers]", `${stagingStanza}[env.staging.triggers]`);
    } else if (out.includes("[env.staging]")) {
      out = `${out.replace(/\n?$/, "\n")}\n${stagingStanza}`;
    }
    // No [env.staging] at all → nothing to wire; production-only repo layout.
  }

  return out;
}

// ─── repo read + the generator ─────────────────────────────────────────────────────

interface FileContents {
  content: string;
  encoding: string;
}

function decodeContents(data: FileContents): string {
  if (data.encoding !== "base64") throw new Error(`unexpected encoding: ${data.encoding}`);
  return decodeURIComponent(escape(atob(data.content.replace(/\n/g, ""))));
}

async function readRepoFile(env: Env, gh: GhAppFetch, path: string): Promise<string> {
  const file = await gh<FileContents>(env, `/repos/${REPO}/contents/${encodeURIComponent(path)}?ref=main`);
  return decodeContents(file);
}

export interface GeneratedAgentFileSet {
  slug: string;
  files: PrFile[];
  secretsNeeded: string[];
}

interface GenerateAgentDeps {
  ghAppFetch: GhAppFetch;
  extraAgentSlugs: Iterable<string>;
  timestamp: string;
}

/**
 * Generate the full scaffold file set for a new dedicated-Worker agent + open-PR wiring. Validates
 * first (refuses on any error, incl. an unknown tool), reads the wiring files from main and applies
 * the edits, renders the new files, and screens every generated file for destructive SQL / inline
 * secrets. Returns { path, content }[] ready for openPR. Nothing is executed; there is no merge.
 */
export async function generateAgentPackage(
  env: Env,
  spec: AgentSpec,
  deps: Partial<GenerateAgentDeps> = {},
): Promise<GeneratedAgentFileSet> {
  const gh = deps.ghAppFetch ?? realGhAppFetch;
  const timestamp = deps.timestamp ?? defaultTimestamp();

  const ctx = agentValidationContext(deps.extraAgentSlugs ?? []);
  const errors = validateAgentSpec(spec, ctx);
  if (errors.length > 0) throw new Tier2ValidationError(errors);

  // New files.
  const indexFile: PrFile = { path: `agents/${spec.slug}/index.ts`, content: renderAgentIndex(spec) };
  const workerFile = renderWorkerEntry(spec);
  const workerWrangler = renderWorkerWrangler(spec);
  const seedMigration = renderAgentSeedMigration(spec, timestamp);
  const manifest = renderAgentManifest(spec);

  // Screen generated content (persona/card are user-supplied → treat as untrusted).
  for (const f of [indexFile, workerFile, workerWrangler, seedMigration, manifest]) {
    assertNoInlineSecrets(f.content, f.path);
  }
  assertNoDestructiveSql(seedMigration.content);

  // Edits to existing wiring files (read current main, apply, blob the full post-edit content).
  const [agentsIndex, agentChat, routesAgents, envTypes, runtimeWrangler] = await Promise.all([
    readRepoFile(env, gh, "agents/index.ts"),
    readRepoFile(env, gh, "runtime/src/agents/agent-chat.ts"),
    readRepoFile(env, gh, "runtime/src/routes/agents.ts"),
    readRepoFile(env, gh, "runtime/src/types/index.ts"),
    readRepoFile(env, gh, "runtime/wrangler.toml"),
  ]);

  const files: PrFile[] = [
    indexFile,
    workerFile,
    workerWrangler,
    seedMigration,
    manifest,
    { path: "agents/index.ts", content: applyAgentsIndexEdit(agentsIndex, spec) },
    { path: "runtime/src/agents/agent-chat.ts", content: applyAgentSlugUnionEdit(agentChat, spec) },
    { path: "runtime/src/routes/agents.ts", content: applyAgentBindingsEdit(routesAgents, spec) },
    { path: "runtime/src/types/index.ts", content: applyWorkerBindingTypeEdit(envTypes, spec) },
    { path: "runtime/wrangler.toml", content: applyWranglerServiceEdit(runtimeWrangler, spec) },
  ];

  return { slug: spec.slug, files, secretsNeeded: spec.secrets ?? [] };
}
