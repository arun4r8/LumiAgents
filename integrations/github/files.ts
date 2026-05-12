import { z } from "zod";
import { defineTool } from "../../runtime/src";
import type { RunContext } from "../../runtime/src/types";
import { githubFetch } from "./base";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitHubFileContent {
  path: string;
  content: string;       // decoded UTF-8 text
  blobSha: string;       // Git blob SHA — used to detect unchanged files
  size: number;
}

export interface GitHubTreeEntry {
  path: string;
  sha: string;
  size: number;
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

export async function fetchFileContent(
  ctx: RunContext,
  owner: string,
  repo: string,
  path: string,
): Promise<GitHubFileContent> {
  const data = await githubFetch<{
    content: string;
    sha: string;
    size: number;
    encoding: string;
  }>(ctx, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);

  if (data.encoding !== "base64") {
    throw new Error(`Unexpected GitHub content encoding: ${data.encoding}`);
  }

  const content = atob(data.content.replace(/\n/g, ""));

  return { path, content, blobSha: data.sha, size: data.size };
}

export async function fetchRepoMarkdownFiles(
  ctx: RunContext,
  owner: string,
  repo: string,
  branch = "main",
): Promise<GitHubTreeEntry[]> {
  const tree = await githubFetch<{
    tree: Array<{ path: string; type: string; sha: string; size?: number }>;
    truncated: boolean;
  }>(ctx, `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);

  if (tree.truncated) {
    // Repos >100k items get truncated. In practice an Obsidian vault won't hit this.
    console.warn(`[vault-sync] GitHub tree truncated for ${owner}/${repo} — large vault`);
  }

  return tree.tree
    .filter((e) => e.type === "blob" && e.path.endsWith(".md"))
    .map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
}

// ─── Write helper ─────────────────────────────────────────────────────────────

export const vaultWriteInputSchema = z.object({
  owner:      z.string().describe("GitHub repo owner (user or org)"),
  repo:       z.string().describe("Repository name"),
  path:       z.string().describe("File path within the repo, e.g. 'Assessments/opp-123.md'"),
  content:    z.string().describe("Full markdown content to write"),
  commitMsg:  z.string().describe("Git commit message"),
  branch:     z.string().default("main"),
});

export const vaultWriteOutputSchema = z.object({
  path:    z.string(),
  sha:     z.string().describe("New blob SHA after write"),
  htmlUrl: z.string().describe("GitHub file URL"),
});

async function getCurrentFileSha(
  ctx: RunContext,
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<string | null> {
  try {
    const data = await githubFetch<{ sha: string }>(
      ctx,
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`,
    );
    return data.sha;
  } catch {
    return null; // file doesn't exist yet
  }
}

export const vaultWrite = defineTool({
  name: "vaultWrite",
  inputSchema: vaultWriteInputSchema,
  outputSchema: vaultWriteOutputSchema,
  async run(ctx: RunContext, input) {
    const existingSha = await getCurrentFileSha(ctx, input.owner, input.repo, input.path, input.branch);

    const body: Record<string, unknown> = {
      message: input.commitMsg,
      content: btoa(unescape(encodeURIComponent(input.content))),
      branch: input.branch,
    };
    if (existingSha) body["sha"] = existingSha;

    const result = await githubFetch<{
      content: { path: string; sha: string; html_url: string };
    }>(ctx, `/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path)}`, {
      method: "PUT",
      body,
    });

    return {
      path:    result.content.path,
      sha:     result.content.sha,
      htmlUrl: result.content.html_url,
    };
  },
});
