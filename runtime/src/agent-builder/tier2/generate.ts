// Tier 2 agent builder (#67): codegen for ONE new orchestration/tool package for an existing
// agent. Clone-and-fill per docs/agent-builder-tier2-design.md §1.2 — everything structural is
// deterministic templating; only the run() body is drafted by an LLM as a PROPOSAL that is
// NEVER executed here (it ships into the PR as a diff a human reviews before merge).
//
// The file set returned is exactly: the new definition.ts, the full post-edit registry.ts, a
// forward-only catalog-registration migration (register_dewey.sql shape), and the agent's
// agent.manifest.yaml. No tools.ts, no new integration (that is Build 2).

import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "../../../../integrations/anthropic/client";
import type { Env } from "../../types";
import { MODELS } from "../../config/models";
import { orchestrations } from "../../registry";
import { ghAppFetch as realGhAppFetch, type GhAppFetch } from "../../integrations/github/app-auth";
import type { PrFile } from "./pr";
import { assertNoDestructiveSql, assertNoInlineSecrets } from "./guards";
import { Tier2ValidationError } from "./errors";

// Re-exported for the many call sites that import it from here (it now lives in errors.ts so
// guards.ts can throw it without an import cycle back into this module).
export { Tier2ValidationError } from "./errors";

const REPO = "LumitureLabs/LumiAgents";

export type SpecFieldType = "string" | "number" | "boolean";

export interface SpecField {
  name: string;
  type: SpecFieldType;
  description: string;
  optional?: boolean;
}

/** The capability proposal an ops user submits: a new orchestration for an existing agent. */
export interface OrchestrationSpec {
  agentSlug: string;
  capabilitySlug: string; // kebab; becomes the orchestration name "<agentSlug>/<capabilitySlug>"
  description: string;
  inputFields: SpecField[];
  output: SpecField[];
  intent: string; // plain-language "what it should do" — seeds the LLM run() draft, never executed
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface ValidationContext {
  existingOrchestrationNames: Set<string>;
  existingAgentSlugs: Set<string>;
}

/** Derive the validation facts (known orchestration names + agent slugs) from the live registry. */
export function registryValidationContext(): ValidationContext {
  const names = new Set<string>();
  const slugs = new Set<string>();
  for (const name of orchestrations.keys()) {
    names.add(name);
    const slug = name.split("/")[0];
    if (slug) slugs.add(slug);
  }
  return { existingOrchestrationNames: names, existingAgentSlugs: slugs };
}

/**
 * Validate a spec before generating anything (design §1.2 / §3b.2): capabilitySlug must be
 * kebab and must not collide with an existing orchestration; the agent must already exist.
 * Returns the list of problems ([] when valid) — pure, no network, fully testable.
 */
export function validateSpec(spec: OrchestrationSpec, ctx: ValidationContext): string[] {
  const errors: string[] = [];

  if (!spec || typeof spec !== "object") {
    return ["spec must be an object."];
  }
  if (!spec.agentSlug || !ctx.existingAgentSlugs.has(spec.agentSlug)) {
    errors.push(
      `Unknown agent slug "${spec.agentSlug ?? ""}". Tier 2 adds a capability to an EXISTING agent.`,
    );
  }
  if (!spec.capabilitySlug || !KEBAB.test(spec.capabilitySlug)) {
    errors.push(
      `capabilitySlug "${spec.capabilitySlug ?? ""}" must be kebab-case (lowercase letters, digits, hyphens).`,
    );
  }
  if (spec.agentSlug && spec.capabilitySlug && KEBAB.test(spec.capabilitySlug)) {
    const name = orchestrationName(spec);
    if (ctx.existingOrchestrationNames.has(name)) {
      errors.push(`Orchestration "${name}" already exists; choose a new capability name.`);
    }
  }
  if (!spec.description || !spec.description.trim()) {
    errors.push("description is required.");
  }
  if (!spec.intent || !spec.intent.trim()) {
    errors.push("intent (what the capability should do) is required.");
  }
  errors.push(...validateFields("inputFields", spec.inputFields));
  errors.push(...validateFields("output", spec.output));

  return errors;
}

function validateFields(label: string, fields: SpecField[] | undefined): string[] {
  const errors: string[] = [];
  if (!Array.isArray(fields) || fields.length === 0) {
    errors.push(`${label} must have at least one field.`);
    return errors;
  }
  const seen = new Set<string>();
  for (const f of fields) {
    if (!f || !FIELD_NAME.test(f.name ?? "")) {
      errors.push(`${label}: field name "${f?.name ?? ""}" must be a valid identifier.`);
      continue;
    }
    if (seen.has(f.name)) errors.push(`${label}: duplicate field "${f.name}".`);
    seen.add(f.name);
    if (f.type !== "string" && f.type !== "number" && f.type !== "boolean") {
      errors.push(`${label}: field "${f.name}" has unsupported type "${String(f.type)}".`);
    }
  }
  return errors;
}

// ─── Naming helpers (pure) ────────────────────────────────────────────────────────

export function orchestrationName(spec: OrchestrationSpec): string {
  return `${spec.agentSlug}/${spec.capabilitySlug}`;
}

/** camelCase import identifier, e.g. ("cleo","reels-plan") → "cleoReelsPlan". */
export function importIdentifier(agentSlug: string, capabilitySlug: string): string {
  const parts = `${agentSlug}-${capabilitySlug}`.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
    .join("");
}

function migrationSlugFragment(spec: OrchestrationSpec): string {
  return `${spec.agentSlug}_${spec.capabilitySlug.replace(/-/g, "_")}`;
}

const MACHINE_HEADER =
  "// ⚠️  MACHINE-DRAFTED by the LumiAgents Tier 2 agent builder (#67) — REVIEW BEFORE MERGE.\n" +
  "// The run() body below is an LLM PROPOSAL. It was NOT executed during generation and must be\n" +
  "// read by an ops engineer before this PR is merged. Nothing ships until a human merges.\n" +
  "// See docs/agent-builder-tier2-design.md.\n";

// ─── zod schema rendering (pure) ──────────────────────────────────────────────────

function zodForField(f: SpecField): string {
  const base = `z.${f.type}()`;
  const withOpt = f.optional ? `${base}.optional()` : base;
  return `${withOpt}.describe(${JSON.stringify(f.description)})`;
}

function renderSchema(name: string, fields: SpecField[]): string {
  const lines = fields.map((f) => `  ${f.name}: ${zodForField(f)},`).join("\n");
  return `export const ${name} = z.object({\n${lines}\n});`;
}

/**
 * Deterministic fallback definition.ts (used when the LLM is unavailable — e.g. no
 * ANTHROPIC_API_KEY / depleted credits). Structurally complete; the run() body is a clearly
 * marked stub a human must complete before merge. Never executed here.
 */
export function renderDefinitionFallback(spec: OrchestrationSpec): string {
  const name = orchestrationName(spec);
  const firstOut = spec.output[0] as SpecField;
  return (
    `${MACHINE_HEADER}` +
    `import { z } from "zod";\n` +
    `import { defineOrchestration, step } from "@/runtime";\n\n` +
    `// ${spec.description}\n` +
    `// Intent: ${spec.intent}\n\n` +
    `${renderSchema("inputSchema", spec.inputFields)}\n\n` +
    `${renderSchema("outputSchema", spec.output)}\n\n` +
    `export default defineOrchestration({\n` +
    `  name: ${JSON.stringify(name)},\n` +
    `  version: 1,\n` +
    `  triggerMode: "agent",\n` +
    `  description: ${JSON.stringify(spec.description)},\n` +
    `  inputSchema,\n` +
    `  outputSchema,\n` +
    `  access: {\n` +
    `    triggerableBy: ["role:ops"],\n` +
    `    visibleTo: ["role:ops"],\n` +
    `  },\n` +
    `  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {\n` +
    `    // TODO(review): implement this capability. This is a machine-drafted STUB — an ops\n` +
    `    // engineer must complete the run() body (side effects only via step() and existing\n` +
    `    // integration tools) before merge. It has never been executed.\n` +
    `    await step(ctx, "not-implemented", async () => {\n` +
    `      throw new Error("${name} is not implemented yet (Tier 2 draft stub).");\n` +
    `    });\n` +
    `    return { ${firstOut ? `${firstOut.name}: input.${(spec.inputFields[0] as SpecField).name}` : ""} } as z.infer<typeof outputSchema>;\n` +
    `  },\n` +
    `});\n`
  );
}

// ─── LLM draft of the run() body ──────────────────────────────────────────────────

const DRAFT_SYSTEM =
  `You draft a single Cloudflare-Workers orchestration file for the LumiAgents platform. ` +
  `You are given a DONOR orchestration as the exact pattern to follow and a SPEC for a new ` +
  `capability. Return ONLY the TypeScript for the new definition.ts — no prose, no markdown fences.\n\n` +
  `Hard rules:\n` +
  `- Follow the donor's structure exactly (imports from "@/runtime", defineOrchestration, step()).\n` +
  `- name MUST be the spec's orchestration name; version: 1; triggerMode: "agent".\n` +
  `- inputSchema/outputSchema MUST be zod objects matching the spec's fields, each with .describe().\n` +
  `- access MUST be { triggerableBy: ["role:ops"], visibleTo: ["role:ops"] }.\n` +
  `- All side effects go through step(ctx, "name", async () => {...}) and EXISTING integration tools only.\n` +
  `- NO raw fetch to new hosts, NO new npm imports, NO reading secrets not already used by the donor.\n` +
  `- This code is a PROPOSAL a human will review; do not include anything that must not be seen in a diff.`;

function firstText(resp: Anthropic.Message): string {
  const b = resp.content.find((x) => x.type === "text");
  return b && b.type === "text" ? b.text : "";
}

function stripFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:ts|typescript)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}

/**
 * Draft the definition.ts run() body via Claude, seeded with the donor + spec. Falls back to the
 * deterministic stub on any failure (missing key, depleted credits, malformed output). The
 * returned code is ALWAYS prefixed with the machine-drafted header and is never executed here.
 */
export async function draftDefinition(
  env: Env,
  donorSource: string,
  spec: OrchestrationSpec,
): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) return renderDefinitionFallback(spec);
  try {
    const client = anthropicClient(env.ANTHROPIC_API_KEY);
    const userPrompt =
      `DONOR orchestration (pattern to follow):\n\`\`\`ts\n${donorSource}\n\`\`\`\n\n` +
      `SPEC for the new capability:\n${JSON.stringify(
        {
          name: orchestrationName(spec),
          description: spec.description,
          intent: spec.intent,
          inputFields: spec.inputFields,
          output: spec.output,
        },
        null,
        2,
      )}\n\nReturn only the new definition.ts.`;
    const resp = await client.messages.create({
      model: MODELS.sonnet,
      max_tokens: 2400,
      system: DRAFT_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    });
    const code = stripFence(firstText(resp));
    // Sanity-check the draft looks like the expected shape; else fall back to the stub.
    if (!code.includes("defineOrchestration") || !code.includes(orchestrationName(spec))) {
      return renderDefinitionFallback(spec);
    }
    return `${MACHINE_HEADER}${code.startsWith("//") ? "\n" : ""}${code}\n`;
  } catch (err) {
    console.error("[tier2] LLM draft failed, using deterministic stub:", err);
    return renderDefinitionFallback(spec);
  }
}

// ─── registry.ts edit (pure) ──────────────────────────────────────────────────────

/**
 * Apply the registry edit to the CURRENT registry.ts content: add one import line and one
 * reg(...) line. Full post-edit content is what gets blobbed into the PR (design §2.1). Pure.
 */
export function applyRegistryEdit(current: string, spec: OrchestrationSpec): string {
  const ident = importIdentifier(spec.agentSlug, spec.capabilitySlug);
  const importLine = `import ${ident} from "../../orchestrations/${spec.agentSlug}/${spec.capabilitySlug}/definition";`;
  const regLine = `  reg(${ident} as unknown as AnyOrch),`;

  if (current.includes(importLine)) return current; // idempotent re-draft

  const lines = current.split("\n");

  // Insert the import after the last orchestration import line.
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import .* from "\.\.\/\.\.\/orchestrations\//.test(lines[i] as string)) lastImportIdx = i;
  }
  if (lastImportIdx === -1) {
    throw new Error("Could not locate the orchestration import block in registry.ts");
  }
  lines.splice(lastImportIdx + 1, 0, importLine);

  // Insert the reg(...) line before the closing "]);" of the orchestrations Map.
  let closeIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] as string).trim() === "]);") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new Error("Could not locate the orchestrations Map terminator (\"]);\") in registry.ts");
  }
  lines.splice(closeIdx, 0, regLine);

  return lines.join("\n");
}

// ─── seed migration (pure) ────────────────────────────────────────────────────────

/** Render the forward-only catalog-registration migration (register_dewey.sql shape). */
export function renderMigration(spec: OrchestrationSpec, timestamp: string): PrFile {
  const name = orchestrationName(spec);
  const path = `supabase/migrations/${timestamp}_register_${migrationSlugFragment(spec)}.sql`;
  const content =
    `-- MACHINE-DRAFTED by the LumiAgents Tier 2 agent builder (#67) — REVIEW BEFORE MERGE.\n` +
    `-- Registers the new orchestration ${name} in the catalog so the dashboard/composer can see it.\n` +
    `-- Forward-only INSERT ... ON CONFLICT (never DDL, never destructive). ops-triggerable / ops-visible.\n` +
    `-- Since #121, merging applies this to STAGING only (deploy-staging.yml runs \`supabase db push\`\n` +
    `-- against the staging project). PRODUCTION is a separate, MANUAL promotion: a human runs the\n` +
    `-- "Deploy Worker (PRODUCTION — manual)" workflow from the Actions tab. Merging ships nothing to\n` +
    `-- customers by itself; the human merge plus the human promotion are the two gates.\n` +
    `--\n` +
    `-- Rollback:\n` +
    `--   DELETE FROM orchestration.orchestrations WHERE name = '${name}' AND version = 1;\n\n` +
    `INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)\n` +
    `VALUES\n` +
    `  ('${name}', 1,\n` +
    `    ${sqlQuote(spec.description)},\n` +
    `    '{}', '{}', true, 'agent')\n` +
    `ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;\n`;
  return { path, content };
}

function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ─── agent.manifest.yaml (pure) ─────────────────────────────────────────────────────

export function manifestPath(spec: OrchestrationSpec): string {
  return `agents/${spec.agentSlug}/agent.manifest.yaml`;
}

/**
 * Render (or extend) the agent's canonical manifest recording the new tool. If no manifest
 * exists yet, create a minimal one; otherwise append the tool under tools.enabled with a
 * `status: proposed` marker ON THE TOOL. The AGENT's own lifecycle stays `active`: this kind adds
 * a capability to an agent that is already live, and marking the agent proposed is exactly the
 * bug that hid live agents from end users (#67). Deterministic; does not attempt a full YAML
 * parse/merge (the human reviews the diff), it just records the new capability idempotently.
 */
export function renderManifest(existing: string | null, spec: OrchestrationSpec): PrFile {
  const path = manifestPath(spec);
  const name = orchestrationName(spec);
  const toolBlock =
    `  - name: ${name}\n` +
    `    description: ${JSON.stringify(spec.description)}\n` +
    `    status: proposed   # machine-drafted; live only after the Tier 2 PR is merged\n`;

  if (!existing || !existing.trim()) {
    const content =
      `# MACHINE-DRAFTED by the LumiAgents Tier 2 agent builder (#67) — REVIEW BEFORE MERGE.\n` +
      `# Canonical manifest for agent "${spec.agentSlug}". Records capabilities (tools) proposed/shipped\n` +
      `# through the agent builder. The TOOL below is 'proposed' until an ops engineer merges this PR;\n` +
      `# the AGENT stays 'active' throughout — a pending proposal never takes a live agent away from\n` +
      `# end users (the agents list hides anything non-active). See #67.\n` +
      `agent: ${spec.agentSlug}\n` +
      `lifecycle: active\n` +
      `tools:\n` +
      `  enabled:\n` +
      toolBlock.replace(/^/gm, "  ");
    return { path, content };
  }

  if (existing.includes(`- name: ${name}`)) {
    return { path, content: existing }; // idempotent re-draft
  }

  // Append under an existing tools.enabled: block if present, else append a tools section.
  let content = existing.replace(/\n?$/, "\n");
  if (/^\s*enabled:\s*$/m.test(content)) {
    content = content.replace(/(^\s*enabled:\s*$)/m, `$1\n${toolBlock.replace(/^/gm, "    ")}`);
  } else {
    content += `tools:\n  enabled:\n${toolBlock.replace(/^/gm, "    ")}`;
  }
  return { path, content };
}

// ─── donor selection + repo reads ──────────────────────────────────────────────────

interface GenerateDeps {
  ghAppFetch: GhAppFetch;
  draftDefinition: (env: Env, donorSource: string, spec: OrchestrationSpec) => Promise<string>;
  timestamp: string;
}

interface ContentsEntry {
  name: string;
  type: string;
  path: string;
}

interface FileContents {
  content: string;
  encoding: string;
}

function decodeContents(data: FileContents): string {
  if (data.encoding !== "base64") throw new Error(`unexpected encoding: ${data.encoding}`);
  return decodeURIComponent(escape(atob(data.content.replace(/\n/g, ""))));
}

/**
 * Pick a donor orchestration from the SAME agent slug (design §1.2): read the agent's
 * orchestrations directory, choose deterministically (alphabetically first that has a
 * definition.ts), and return its source. The donor is the pattern the LLM clones.
 */
async function selectDonor(
  env: Env,
  spec: OrchestrationSpec,
  gh: GhAppFetch,
): Promise<{ path: string; source: string }> {
  const dir = await gh<ContentsEntry[]>(
    env,
    `/repos/${REPO}/contents/orchestrations/${spec.agentSlug}`,
  );
  const candidates = dir
    .filter((e) => e.type === "dir")
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  for (const cand of candidates) {
    const defPath = `orchestrations/${spec.agentSlug}/${cand}/definition.ts`;
    try {
      const file = await gh<FileContents>(env, `/repos/${REPO}/contents/${defPath}?ref=main`);
      return { path: defPath, source: decodeContents(file) };
    } catch {
      // no definition.ts in this dir (e.g. a namespace re-export); try the next candidate.
    }
  }
  throw new Error(`No donor orchestration with a definition.ts found under orchestrations/${spec.agentSlug}`);
}

async function readRepoFile(env: Env, gh: GhAppFetch, path: string): Promise<string | null> {
  try {
    const file = await gh<FileContents>(env, `/repos/${REPO}/contents/${encodeURIComponent(path)}?ref=main`);
    return decodeContents(file);
  } catch {
    return null;
  }
}

// ─── The generator ─────────────────────────────────────────────────────────────────

export interface GeneratedPackage {
  orchestrationName: string;
  files: PrFile[];
  usedDonor: string;
}

/**
 * Generate the full Tier 2 file set for a new orchestration/tool on an existing agent. Validates
 * first (refuses on any error), clones the closest donor, drafts the definition.ts run() body via
 * the LLM (proposal only — never executed), and templates the registry edit, the seed migration,
 * and the manifest. Returns { path, content }[] ready for openPR. No tools.ts / new integration.
 *
 * Safety: EVERY file in the set is screened by assertNoInlineSecrets and the migration by
 * assertNoDestructiveSql before it can reach a PR. This kind is the only one whose content a
 * MODEL writes (the definition.ts run() body), so it is the kind that most needs the screen —
 * it was the one kind that had never been wired to guards.ts (audit #67). The screen runs over
 * the definition, the post-edit registry.ts, the migration and the manifest alike, because the
 * spec's description/intent (untrusted ops input) is interpolated into all of them.
 */
export async function generateOrchestrationPackage(
  env: Env,
  spec: OrchestrationSpec,
  deps: Partial<GenerateDeps> = {},
): Promise<GeneratedPackage> {
  const gh = deps.ghAppFetch ?? realGhAppFetch;
  const draft = deps.draftDefinition ?? draftDefinition;
  const timestamp = deps.timestamp ?? defaultTimestamp();

  // Validation gate (design §1.2): kebab slug, no collision, agent exists.
  const errors = validateSpec(spec, registryValidationContext());
  if (errors.length > 0) throw new Tier2ValidationError(errors);

  // Clone-and-fill: donor from the same agent, LLM-drafted definition (proposal, not executed).
  const donor = await selectDonor(env, spec, gh);
  const definitionSource = await draft(env, donor.source, spec);

  // Deterministic templating for everything structural.
  const currentRegistry = await readRepoFile(env, gh, "runtime/src/registry.ts");
  if (currentRegistry === null) throw new Error("Could not read runtime/src/registry.ts from main");
  const newRegistry = applyRegistryEdit(currentRegistry, spec);

  const migration = renderMigration(spec, timestamp);

  const existingManifest = await readRepoFile(env, gh, manifestPath(spec));
  const manifest = renderManifest(existingManifest, spec);

  const definitionFile: PrFile = {
    path: `orchestrations/${spec.agentSlug}/${spec.capabilitySlug}/definition.ts`,
    content: definitionSource,
  };
  const registryFile: PrFile = { path: "runtime/src/registry.ts", content: newRegistry };

  const files = [definitionFile, registryFile, migration, manifest];

  // Safety backstop (the LLM draft is untrusted content): no inline secret VALUE in any file,
  // and the generated migration must stay forward-only / non-destructive. Both throw
  // Tier2ValidationError, which the route maps to a 400 — nothing reaches a PR.
  for (const f of files) assertNoInlineSecrets(f.content, f.path);
  assertNoDestructiveSql(migration.content);

  return {
    orchestrationName: orchestrationName(spec),
    usedDonor: donor.path,
    files,
  };
}

/** Migration-filename timestamp: YYYYMMDDHHMMSS-ish, sorts after existing migrations. */
export function defaultTimestamp(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}
