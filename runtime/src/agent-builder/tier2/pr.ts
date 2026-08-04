// Tier 2 agent builder (#67): PR automation via the GitHub Git Data API.
//
// A Tier 2 draft is a multi-file change on a fresh branch, so it uses blobs → tree → commit →
// ref → pull (not per-file PUT /contents). Everything goes through ghAppFetch against
// LumitureLabs/LumiAgents. The App credential can OPEN a PR but cannot merge it — the human
// merge is the entire governance gate. This module NEVER merges.

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
 *   6. POST refs/heads/<branch>
 *   7. POST /pulls (head = branch, base = main)
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

  // 6. create the branch ref
  await gh<{ ref: string }>(env, `/repos/${REPO}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${args.branch}`, sha: commit.sha },
  });

  // 7. open the PR against main (never merged here)
  const pr = await gh<{ html_url: string; number: number }>(env, `/repos/${REPO}/pulls`, {
    method: "POST",
    body: { title: args.title, body: args.body, head: args.branch, base: BASE_BRANCH },
  });

  return { htmlUrl: pr.html_url, number: pr.number, branch: args.branch, headSha: commit.sha };
}
