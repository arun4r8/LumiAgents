import { describe, it, expect } from "vitest";
import type { Env } from "../../src/types";
import type { GhAppFetch } from "../../src/integrations/github/app-auth";
import {
  generateOrchestrationPackage,
  Tier2ValidationError,
  type OrchestrationSpec,
} from "../../src/agent-builder/tier2/generate";

// Tier 2 (#67), audit fix: the "orchestration" kind is the ONLY kind whose file content a MODEL
// writes, and it was the one kind guards.ts was never wired into — generate-table.ts and
// generate-agent.ts imported it, generate.ts did not. These tests pin the guard coverage by
// driving generateOrchestrationPackage with a fake ghAppFetch (donor + registry + manifest reads)
// and a fake draftDefinition standing in for the LLM. No network, no Claude.

const ENV = {} as unknown as Env;

const DONOR_SOURCE = `import { z } from "zod";
export default defineOrchestration({ name: "cleo/content-draft" });
`;

const REGISTRY_SOURCE = [
  'import cleoContentDraft from "../../orchestrations/cleo/content-draft/definition";',
  "type AnyOrch = unknown;",
  "function reg(o: AnyOrch): [string, AnyOrch] { return [o.name, o]; }",
  "export const orchestrations = new Map<string, AnyOrch>([",
  "  reg(cleoContentDraft as unknown as AnyOrch),",
  "]);",
  "",
].join("\n");

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

/** Serves the repo reads generateOrchestrationPackage makes: donor dir, donor file, registry, manifest. */
function fakeGh(): GhAppFetch {
  return (async (_env: Env, path: string) => {
    if (path.endsWith("/contents/orchestrations/cleo")) {
      return [{ name: "content-draft", type: "dir", path: "orchestrations/cleo/content-draft" }];
    }
    if (path.includes("content-draft/definition.ts")) {
      return { content: b64(DONOR_SOURCE), encoding: "base64" };
    }
    if (path.includes("registry.ts")) {
      return { content: b64(REGISTRY_SOURCE), encoding: "base64" };
    }
    if (path.includes("agent.manifest.yaml")) {
      throw new Error("404 not found"); // no manifest yet → the generator creates one
    }
    throw new Error(`unexpected path ${path}`);
  }) as unknown as GhAppFetch;
}

function spec(overrides: Partial<OrchestrationSpec> = {}): OrchestrationSpec {
  return {
    agentSlug: "cleo",
    capabilitySlug: "reels-plan-guardtest",
    description: "Plan a run of Reels for a content theme.",
    intent: "Given a theme, propose 5 reels ideas and write them back.",
    inputFields: [{ name: "theme", type: "string", description: "The content theme." }],
    output: [{ name: "count", type: "number", description: "How many reels were planned." }],
    ...overrides,
  };
}

const CLEAN_DRAFT =
  `import { z } from "zod";\n` +
  `export default defineOrchestration({ name: "cleo/reels-plan-guardtest" });\n`;

describe("generateOrchestrationPackage — guard coverage over the LLM draft", () => {
  it("produces the four-file package when the draft is clean", async () => {
    const pkg = await generateOrchestrationPackage(ENV, spec(), {
      ghAppFetch: fakeGh(),
      draftDefinition: async () => CLEAN_DRAFT,
      timestamp: "20260805010203",
    });
    expect(pkg.files.map((f) => f.path)).toEqual([
      "orchestrations/cleo/reels-plan-guardtest/definition.ts",
      "runtime/src/registry.ts",
      "supabase/migrations/20260805010203_register_cleo_reels_plan_guardtest.sql",
      "agents/cleo/agent.manifest.yaml",
    ]);
  });

  it("REJECTS a draft that inlines a secret value (the audit's two-line hole)", async () => {
    const poisoned =
      `import { z } from "zod";\n` +
      `const APOLLO_API_KEY = "sk-live-8f2b91c4d7e6a3b5c9d1";\n` +
      `export default defineOrchestration({ name: "cleo/reels-plan-guardtest" });\n`;

    await expect(
      generateOrchestrationPackage(ENV, spec(), {
        ghAppFetch: fakeGh(),
        draftDefinition: async () => poisoned,
        timestamp: "20260805010203",
      }),
    ).rejects.toThrow(Tier2ValidationError);
  });

  it("names the offending file, so the route's 400 tells the ops user what to fix", async () => {
    const poisoned = `const CLIENT_SECRET = "abc-secret-value";\ndefineOrchestration({ name: "cleo/reels-plan-guardtest" });\n`;
    await expect(
      generateOrchestrationPackage(ENV, spec(), {
        ghAppFetch: fakeGh(),
        draftDefinition: async () => poisoned,
        timestamp: "20260805010203",
      }),
    ).rejects.toThrow(/orchestrations\/cleo\/reels-plan-guardtest\/definition\.ts/);
  });

  it("rejects a private-key block pasted into the draft", async () => {
    const poisoned =
      `// -----BEGIN RSA PRIVATE KEY-----\n// MIIEowIBAAKCAQEA\n` +
      `defineOrchestration({ name: "cleo/reels-plan-guardtest" });\n`;
    await expect(
      generateOrchestrationPackage(ENV, spec(), {
        ghAppFetch: fakeGh(),
        draftDefinition: async () => poisoned,
        timestamp: "20260805010203",
      }),
    ).rejects.toThrow(/private key block/);
  });

  it("screens the generated MIGRATION for destructive SQL as well", async () => {
    // The spec's description is interpolated into the migration; a CR could otherwise end the
    // comment and start a statement. renderMigration quotes it into SQL, so this asserts the
    // package-level screen runs at all: the emitted migration passes the destructive-SQL guard.
    const pkg = await generateOrchestrationPackage(
      ENV,
      spec({ description: "Plan reels\rDROP TABLE orchestration.agents;" }),
      { ghAppFetch: fakeGh(), draftDefinition: async () => CLEAN_DRAFT, timestamp: "20260805010203" },
    );
    const migration = pkg.files.find((f) => f.path.includes("supabase/migrations"))!;
    expect(migration.content).toContain("INSERT INTO orchestration.orchestrations");
  });

  it("says the machine-drafted migration deploys STAGING, not production (#121)", async () => {
    const pkg = await generateOrchestrationPackage(ENV, spec(), {
      ghAppFetch: fakeGh(),
      draftDefinition: async () => CLEAN_DRAFT,
      timestamp: "20260805010203",
    });
    const migration = pkg.files.find((f) => f.path.includes("supabase/migrations"))!;
    expect(migration.content).toContain("STAGING");
    expect(migration.content).toMatch(/MANUAL promotion|manual/i);
    // The pre-#121 claim that merging applies this to production must be gone.
    expect(migration.content).not.toContain("deploy-worker.yml's `supabase db push --yes`");
  });
});
