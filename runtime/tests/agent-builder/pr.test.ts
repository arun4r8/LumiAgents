import { describe, it, expect } from "vitest";
import type { Env } from "../../src/types";
import type { GhAppFetch } from "../../src/integrations/github/app-auth";
import {
  deterministicShortId,
  namespacedBranch,
  toBase64,
  assembleTreeEntries,
  openPR,
  type PrFile,
} from "../../src/agent-builder/tier2/pr";

// Tier 2 (#67): PR file-set assembly via the Git Data API, exercised against a fake ghAppFetch
// that records every call — no network, no GitHub.

const ENV = {} as unknown as Env;

describe("branch + short id", () => {
  it("derives a stable short id from the payload (re-drafts reuse the branch)", async () => {
    const a = await deterministicShortId(JSON.stringify({ x: 1 }));
    const b = await deterministicShortId(JSON.stringify({ x: 1 }));
    const c = await deterministicShortId(JSON.stringify({ x: 2 }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("namespaces branches under agent-builder/<slug>/<name>-<id>", () => {
    expect(namespacedBranch("cleo", "reels-plan", "deadbeef")).toBe("agent-builder/cleo/reels-plan-deadbeef");
  });
});

describe("assembleTreeEntries", () => {
  const files: PrFile[] = [
    { path: "a/definition.ts", content: "x" },
    { path: "runtime/src/registry.ts", content: "y" },
  ];

  it("maps files 1:1 to 100644 blob entries with their shas", () => {
    const entries = assembleTreeEntries(files, ["sha1", "sha2"]);
    expect(entries).toEqual([
      { path: "a/definition.ts", mode: "100644", type: "blob", sha: "sha1" },
      { path: "runtime/src/registry.ts", mode: "100644", type: "blob", sha: "sha2" },
    ]);
  });

  it("refuses a sha/file count mismatch", () => {
    expect(() => assembleTreeEntries(files, ["sha1"])).toThrow(/does not match/);
  });

  it("base64-encodes utf-8 content losslessly", () => {
    expect(decodeURIComponent(escape(atob(toBase64("héllo 🚀"))))).toBe("héllo 🚀");
  });
});

describe("openPR", () => {
  it("runs blob→tree→commit→ref→pull and returns the PR + head sha", async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    let blobN = 0;
    const fakeGh = (async (_env: Env, path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body });
      if (path.endsWith("/git/ref/heads/main")) return { object: { sha: "BASECOMMIT" } };
      if (path.endsWith("/git/commits/BASECOMMIT")) return { tree: { sha: "BASETREE" } };
      if (path.endsWith("/git/blobs")) return { sha: `BLOB${blobN++}` };
      if (path.endsWith("/git/trees")) return { sha: "NEWTREE" };
      if (path.endsWith("/git/commits")) return { sha: "NEWCOMMIT" };
      if (path.endsWith("/git/refs")) return { ref: "refs/heads/x" };
      if (path.endsWith("/pulls")) return { html_url: "https://github.com/LumitureLabs/LumiAgents/pull/7", number: 7 };
      throw new Error(`unexpected path ${path}`);
    }) as unknown as GhAppFetch;

    const files: PrFile[] = [
      { path: "orchestrations/cleo/reels-plan/definition.ts", content: "// def" },
      { path: "runtime/src/registry.ts", content: "// reg" },
      { path: "supabase/migrations/x_register.sql", content: "-- mig" },
    ];
    const result = await openPR(
      ENV,
      { branch: "agent-builder/cleo/reels-plan-abcd1234", files, title: "T", body: "B" },
      { ghAppFetch: fakeGh },
    );

    expect(result).toEqual({
      htmlUrl: "https://github.com/LumitureLabs/LumiAgents/pull/7",
      number: 7,
      branch: "agent-builder/cleo/reels-plan-abcd1234",
      headSha: "NEWCOMMIT",
    });

    // One blob POST per file.
    const blobPosts = calls.filter((c) => c.path.endsWith("/git/blobs"));
    expect(blobPosts).toHaveLength(3);
    expect((blobPosts[0]!.body as { encoding: string }).encoding).toBe("base64");

    // Tree built on the base tree with all three files.
    const treeCall = calls.find((c) => c.path.endsWith("/git/trees"))!;
    const treeBody = treeCall.body as { base_tree: string; tree: { path: string }[] };
    expect(treeBody.base_tree).toBe("BASETREE");
    expect(treeBody.tree.map((t) => t.path)).toEqual(files.map((f) => f.path));

    // Commit parented on the current main head, on the new tree.
    const commitBody = calls.find((c) => c.path.endsWith("/git/commits") && c.method === "POST")!.body as {
      parents: string[];
      tree: string;
    };
    expect(commitBody.parents).toEqual(["BASECOMMIT"]);
    expect(commitBody.tree).toBe("NEWTREE");

    // Branch ref + PR head/base — and NO merge call anywhere.
    const refBody = calls.find((c) => c.path.endsWith("/git/refs"))!.body as { ref: string; sha: string };
    expect(refBody).toEqual({ ref: "refs/heads/agent-builder/cleo/reels-plan-abcd1234", sha: "NEWCOMMIT" });
    const prBody = calls.find((c) => c.path.endsWith("/pulls"))!.body as { head: string; base: string };
    expect(prBody).toEqual(expect.objectContaining({ head: "agent-builder/cleo/reels-plan-abcd1234", base: "main" }));
    expect(calls.some((c) => c.path.includes("/merge"))).toBe(false);
  });
});
