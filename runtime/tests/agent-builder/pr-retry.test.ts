import { describe, it, expect } from "vitest";
import type { Env } from "../../src/types";
import type { GhAppFetch } from "../../src/integrations/github/app-auth";
import {
  openPR,
  createOrReuseBranch,
  isRefAlreadyExists,
  isPullAlreadyExists,
  type PrFile,
} from "../../src/agent-builder/tier2/pr";

// Tier 2 (#67), audit fix: a failed draft used to be unrecoverable FOR THE SAME SPEC. `shortId` is
// a hash of the spec, so a retry asks for the exact same branch; `POST /git/refs` then 422s
// ("Reference already exists") forever, and the proposal could never be drafted again without a
// human deleting the branch. These tests pin the recovery.

const ENV = {} as unknown as Env;

const FILES: PrFile[] = [{ path: "orchestrations/cleo/reels-plan/definition.ts", content: "// def" }];
const BRANCH = "agent-builder/cleo/reels-plan-abcd1234";

const REF_EXISTS = () => new Error("GitHub App API POST /repos/x/git/refs → 422: Reference already exists");

/**
 * A fake ghAppFetch driving the whole openPR sequence. `existingRefs` are branches that already
 * exist; `refuseRefUpdate` makes PATCHing them fail, forcing the suffixed-branch fallback.
 */
function fakeGh(opts: {
  existingRefs?: Set<string>;
  refuseRefUpdate?: boolean;
  pullAlreadyExists?: boolean;
  calls?: { path: string; method: string; body: unknown }[];
}): GhAppFetch {
  const existing = opts.existingRefs ?? new Set<string>();
  const calls = opts.calls ?? [];
  let blobN = 0;
  return (async (_env: Env, path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body });
    if (path.endsWith("/git/ref/heads/main")) return { object: { sha: "BASECOMMIT" } };
    if (path.endsWith("/git/commits/BASECOMMIT")) return { tree: { sha: "BASETREE" } };
    if (path.endsWith("/git/blobs")) return { sha: `BLOB${blobN++}` };
    if (path.endsWith("/git/trees")) return { sha: "NEWTREE" };
    if (path.endsWith("/git/commits")) return { sha: "NEWCOMMIT" };
    if (path.endsWith("/git/refs") && method === "POST") {
      const ref = (init?.body as { ref: string }).ref.replace("refs/heads/", "");
      if (existing.has(ref)) throw REF_EXISTS();
      existing.add(ref);
      return { ref };
    }
    if (path.includes("/git/refs/heads/") && method === "PATCH") {
      if (opts.refuseRefUpdate) throw new Error("GitHub App API PATCH → 422: Update is not a fast forward");
      return { ref: path.split("/git/refs/")[1] };
    }
    if (path.endsWith("/pulls") && method === "POST") {
      if (opts.pullAlreadyExists) {
        throw new Error("GitHub App API POST /repos/x/pulls → 422: A pull request already exists for x:branch.");
      }
      return { html_url: "https://github.com/LumitureLabs/LumiAgents/pull/7", number: 7 };
    }
    if (path.includes("/pulls?state=open")) {
      return [{ html_url: "https://github.com/LumitureLabs/LumiAgents/pull/5", number: 5 }];
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as unknown as GhAppFetch;
}

describe("error classification", () => {
  it("recognises GitHub's 'Reference already exists' 422", () => {
    expect(isRefAlreadyExists(REF_EXISTS())).toBe(true);
    expect(isRefAlreadyExists(new Error("422: Validation Failed: name is too long"))).toBe(false);
  });

  it("recognises GitHub's 'A pull request already exists' 422", () => {
    expect(isPullAlreadyExists(new Error("422: A pull request already exists for org:branch."))).toBe(true);
    expect(isPullAlreadyExists(new Error("404: Not Found"))).toBe(false);
  });
});

describe("createOrReuseBranch", () => {
  it("creates the branch normally when it does not exist", async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const used = await createOrReuseBranch(ENV, fakeGh({ calls }), BRANCH, "NEWCOMMIT");
    expect(used).toBe(BRANCH);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("moves an existing branch forward instead of 422ing forever", async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const used = await createOrReuseBranch(
      ENV,
      fakeGh({ existingRefs: new Set([BRANCH]), calls }),
      BRANCH,
      "NEWCOMMIT",
    );
    expect(used).toBe(BRANCH);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toContain(`/git/refs/heads/${BRANCH}`);
    expect(patch.body).toEqual({ sha: "NEWCOMMIT", force: true });
  });

  it("falls back to a suffixed branch when the existing ref cannot be updated", async () => {
    const used = await createOrReuseBranch(
      ENV,
      fakeGh({ existingRefs: new Set([BRANCH]), refuseRefUpdate: true }),
      BRANCH,
      "NEWCOMMIT",
    );
    expect(used).toBe(`${BRANCH}-2`);
  });

  it("gives a clear error only after exhausting the suffixed variants", async () => {
    const all = new Set([BRANCH, `${BRANCH}-2`, `${BRANCH}-3`, `${BRANCH}-4`]);
    await expect(
      createOrReuseBranch(ENV, fakeGh({ existingRefs: all, refuseRefUpdate: true }), BRANCH, "NEWCOMMIT"),
    ).rejects.toThrow(/Delete the stale branch and retry/);
  });
});

describe("openPR recovery", () => {
  it("re-drafting the same spec after a half-finished draft still opens a PR", async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const result = await openPR(
      ENV,
      { branch: BRANCH, files: FILES, title: "T", body: "B" },
      { ghAppFetch: fakeGh({ existingRefs: new Set([BRANCH]), calls }) },
    );
    expect(result.number).toBe(7);
    expect(result.branch).toBe(BRANCH);
    // Still no merge call anywhere on the recovery path.
    expect(calls.some((c) => c.path.includes("/merge"))).toBe(false);
  });

  it("reports the suffixed branch it actually used", async () => {
    const result = await openPR(
      ENV,
      { branch: BRANCH, files: FILES, title: "T", body: "B" },
      { ghAppFetch: fakeGh({ existingRefs: new Set([BRANCH]), refuseRefUpdate: true }) },
    );
    expect(result.branch).toBe(`${BRANCH}-2`);
  });

  it("adopts an already-open PR for the same head instead of failing", async () => {
    const result = await openPR(
      ENV,
      { branch: BRANCH, files: FILES, title: "T", body: "B" },
      { ghAppFetch: fakeGh({ existingRefs: new Set([BRANCH]), pullAlreadyExists: true }) },
    );
    expect(result.number).toBe(5);
  });
});
