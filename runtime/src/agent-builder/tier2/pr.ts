// Tier 2 agent builder (#67): PR automation via the GitHub Git Data API.
//
// A Tier 2 draft is a multi-file change on a fresh branch, so it uses blobs → tree → commit →
// ref → pull (not per-file PUT /contents). Everything goes through ghAppFetch against
// LumitureLabs/LumiAgents.
//
// This module NEVER merges: there is no `PUT /pulls/{n}/merge` call anywhere in the codebase, and
// the human merge is the entire governance gate. Be precise about WHY, because the old comment
// here overstated it: `PUT /pulls/{n}/merge` needs exactly Contents:write + Pull requests:write,
// which the App HAS. The guarantee is "no code path calls merge", not "the credential is
// incapable of merging" (see integrations/github/app-auth.ts). Keep it that way.

import type { Env } from "../../types";
import { ghAppFetch as realGhAppFetch, type GhAppFetch } from "../../integrations/github/app-auth";

const REPO = "LumitureLabs/LumiAgents";
const BASE_BRANCH = "main";

export interface PrFile {
  path: string;
  content: string;
}

export interface OpenPrArgs {
  branch: string;
  files: PrFile[];
  title: string;
  body: string;
}

export interface OpenPrResult {
  htmlUrl: string;
  number: number;
  branch: string;
  headSha: string;
}

// ─── Pure helpers (testable without network) ────────────────────────────────────

/**
 * Deterministic short id derived from the payload. Math.random is unavailable/forbidden here,
 * and re-drafting the same spec must reuse the same branch, so we hash the input instead.
 */
export async function deterministicShortId(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest).slice(0, 4);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Branch names are namespaced agent-builder/<slug>/<name>-<shortid>. */
export function namespacedBranch(agentSlug: string, capabilitySlug: string, shortId: string): string {
  return `agent-builder/${agentSlug}/${capabilitySlug}-${shortId}`;
}

/** UTF-8 safe base64 for a git blob's content. */
export function toBase64(content: string): string {
  return btoa(unescape(encodeURIComponent(content)));
}

export interface TreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string;
}

/** Assemble the git tree entries from the file set and their blob shas (1:1, ordered). */
export function assembleTreeEntries(files: PrFile[], blobShas: string[]): TreeEntry[] {
  if (files.length !== blobShas.length) {
    throw new Error(`blob sha count (${blobShas.length}) does not match file count (${files.length})`);
  }
  return files.map((f, i) => ({
    path: f.path,
    mode: "100644" as const,
    type: "blob" as const,
    sha: blobShas[i] as string,
  }));
}

// ─── openPR ─────────────────────────────────────────────────────────────────────

interface OpenPrDeps {
  ghAppFetch: GhAppFetch;
}

/**
 * Open a PR carrying the generated file set. Sequence (Git Data API):
 *   1. GET base ref heads/main → base commit sha
 *   2. GET base commit → base tree sha
 *   3. POST a blob per file
 *   4. POST a tree (base_tree = base tree sha)
 *   5. POST a commit (parent = base commit sha)
 *   6. POST refs/heads/<branch> (falling back to PATCH / a suffixed name — see createOrReuseBranch)
 *   7. POST /pulls (head = branch, base = main), adopting an already-open PR for the same head
 *
 * `deps` is injectable so tests can supply a fake ghAppFetch and assert the file-set assembly
 * without hitting GitHub. Returns { htmlUrl, number, branch, headSha }. Never merges.
 */
export async function openPR(
  env: Env,
  args: OpenPrArgs,
  deps: OpenPrDeps = { ghAppFetch: realGhAppFetch },
): Promise<OpenPrResult> {
  const gh = deps.ghAppFetch;

  // 1. base ref → base commit sha
  const ref = await gh<{ object: { sha: string } }>(env, `/repos/${REPO}/git/ref/heads/${BASE_BRANCH}`);
  const baseSha = ref.object.sha;

  // 2. base commit → base tree sha
  const baseCommit = await gh<{ tree: { sha: string } }>(env, `/repos/${REPO}/git/commits/${baseSha}`);
  const baseTreeSha = baseCommit.tree.sha;

  // 3. one blob per file
  const blobShas: string[] = [];
  for (const file of args.files) {
    const blob = await gh<{ sha: string }>(env, `/repos/${REPO}/git/blobs`, {
      method: "POST",
      body: { content: toBase64(file.content), encoding: "base64" },
    });
    blobShas.push(blob.sha);
  }

  // 4. tree on top of the base tree
  const tree = await gh<{ sha: string }>(env, `/repos/${REPO}/git/trees`, {
    method: "POST",
    body: { base_tree: baseTreeSha, tree: assembleTreeEntries(args.files, blobShas) },
  });

  // 5. commit (parent = current main head)
  const commit = await gh<{ sha: string }>(env, `/repos/${REPO}/git/commits`, {
    method: "POST",
    body: { message: `${args.title}\n\n${args.body}`, tree: tree.sha, parents: [baseSha] },
  });

  // 6. create the branch ref — retrying past a leftover branch from a failed earlier draft
  const branch = await createOrReuseBranch(env, gh, args.branch, commit.sha);

  // 7. open the PR against main (never merged here). If one is already open for this head
  //    (a draft that died between opening the PR and returning), adopt it instead of failing.
  let pr: { html_url: string; number: number };
  try {
    pr = await gh<{ html_url: string; number: number }>(env, `/repos/${REPO}/pulls`, {
      method: "POST",
      body: { title: args.title, body: args.body, head: branch, base: BASE_BRANCH },
    });
  } catch (err) {
    if (!isPullAlreadyExists(err)) throw err;
    const existing = await gh<{ html_url: string; number: number }[]>(
      env,
      `/repos/${REPO}/pulls?state=open&head=${encodeURIComponent(`${REPO.split("/")[0]}:${branch}`)}`,
    );
    const first = existing[0];
    if (!first) throw err;
    pr = first;
  }

  return { htmlUrl: pr.html_url, number: pr.number, branch, headSha: commit.sha };
}

// ─── branch creation that survives a half-finished earlier draft ─────────────────

/** GitHub answers a duplicate `POST /git/refs` with 422 "Reference already exists". */
export function isRefAlreadyExists(err: unknown): boolean {
  return /Reference already exists/i.test(err instanceof Error ? err.message : String(err));
}

/** GitHub answers a duplicate `POST /pulls` with 422 "A pull request already exists for …". */
export function isPullAlreadyExists(err: unknown): boolean {
  return /pull request already exists/i.test(err instanceof Error ? err.message : String(err));
}

const MAX_BRANCH_ATTEMPTS = 4;

/**
 * Create `refs/heads/<branch>` at `sha`, tolerating a branch left behind by a draft that died
 * after step 6 (audit #67: `shortId` is deterministic, so every retry of the same spec asked for
 * the same branch and 422'd forever — the spec became permanently un-draftable).
 *
 * Recovery order:
 *   1. POST the ref (the normal path).
 *   2. On "Reference already exists", PATCH it forward to the new commit. That is safe precisely
 *      because the branch name is a hash of THIS spec: the only thing that can be sitting there
 *      is an earlier draft of the same proposal, and its commit is parented on main, so nothing
 *      a human wrote is lost.
 *   3. If the PATCH is refused too (e.g. the branch is protected, or a race), fall back to a
 *      suffixed branch `<branch>-2`, `-3`, … so the draft still lands.
 *
 * Returns the branch name actually used.
 */
export async function createOrReuseBranch(
  env: Env,
  gh: GhAppFetch,
  branch: string,
  sha: string,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_BRANCH_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? branch : `${branch}-${attempt}`;
    try {
      await gh<{ ref: string }>(env, `/repos/${REPO}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${candidate}`, sha },
      });
      return candidate;
    } catch (err) {
      if (!isRefAlreadyExists(err)) throw err;
      try {
        await gh<{ ref: string }>(env, `/repos/${REPO}/git/refs/heads/${candidate}`, {
          method: "PATCH",
          body: { sha, force: true },
        });
        return candidate;
      } catch {
        // Could not move the existing ref; try the next suffixed name.
      }
    }
  }
  throw new Error(
    `Could not create a branch for this draft: "${branch}" and ${MAX_BRANCH_ATTEMPTS - 1} suffixed ` +
      `variants already exist and could not be updated. Delete the stale branch and retry.`,
  );
}
