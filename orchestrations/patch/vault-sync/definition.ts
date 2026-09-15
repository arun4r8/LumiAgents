import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { fetchFileContent, fetchRepoMarkdownFiles } from "../../../integrations/github/files";
import { upsertVaultDocument, removeVaultDocument } from "../../../runtime/src/agents/vault-sync";
import { vaultSourceUri } from "../../../integrations/github/base";
import { sbHeaders } from "@/runtime/utils/supabase";

export const inputSchema = z.object({
  repoOwner:    z.string().describe("GitHub owner (user or org) of the Obsidian vault repo"),
  repoName:     z.string().describe("Repository name of the Obsidian vault"),
  branch:       z.string().default("main").describe("Branch of the vault repo to sync from"),
  changedPaths: z.array(z.string()).optional()
    .describe("Specific file paths to sync, supplied by GitHub push webhook. Omit for full vault sync."),
  removedPaths: z.array(z.string()).optional()
    .describe("File paths deleted in this push. These are removed from the RAG index."),
});

export const outputSchema = z.object({
  ingested: z.number().describe("Files newly embedded or re-embedded due to content change"),
  skipped:  z.number().describe("Files skipped because blob SHA was unchanged"),
  remaining: z.number().default(0).describe("Changed files left for the next run, beyond MAX_VAULT_FILES_PER_RUN."),
  removed:  z.number().describe("Files removed from the RAG index"),
  errors:   z.array(z.string()),
});

/**
 * The most files one run will (re-)embed. Each costs up to five subrequests -- the
 * GitHub contents fetch, a delete of the old index row, the document insert, the
 * chunk insert, and the embedding call -- against a ceiling of 50 for the whole
 * invocation. Unchanged files cost nothing: they are skipped on the tree's blob
 * SHA before their contents are fetched. A vault with more changed files than this
 * finishes over several runs; `remaining` says how many are left.
 */
export const MAX_VAULT_FILES_PER_RUN = 6;

export interface VaultCandidate { path: string; sha: string | null }
export interface IndexedDoc { id: string; blobSha: string | null }

/**
 * Which files to embed this run, as a pure decision.
 *
 * A file whose tree SHA matches its indexed blob SHA is unchanged and skipped
 * without a fetch. A file with no SHA (a webhook path list carries none) is
 * treated as possibly changed; upsertVaultDocument re-checks after fetching.
 * Order is the input's, so a capped run resumes predictably next time.
 */
export function selectVaultFiles(
  candidates: VaultCandidate[],
  index: Map<string, IndexedDoc>,
  sourceUriFor: (path: string) => string,
  cap: number = MAX_VAULT_FILES_PER_RUN,
): { toIngest: Array<VaultCandidate & { existing: IndexedDoc | null }>; unchanged: number; remaining: number } {
  const changed: Array<VaultCandidate & { existing: IndexedDoc | null }> = [];
  let unchanged = 0;
  for (const c of candidates) {
    const existing = index.get(sourceUriFor(c.path)) ?? null;
    if (existing && c.sha !== null && existing.blobSha === c.sha) {
      unchanged++;
      continue;
    }
    changed.push({ ...c, existing });
  }
  return { toIngest: changed.slice(0, cap), unchanged, remaining: Math.max(0, changed.length - cap) };
}

export default defineOrchestration({
  name: "patch/vault-sync",
  version: 1,
  description:
    "Sync an Obsidian vault from a GitHub repository into the document RAG knowledge base. " +
    "Runs on every push (incremental) or on demand (full). Skips files whose content hasn't changed.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo:     ["role:ops"],
  },

  async run(ctx, input) {
    const { repoOwner: owner, repoName: repo, branch } = input;

    // ── Step 1: Resolve the file list (with blob SHAs, from the tree) ─────────
    const candidates = await step(ctx, "resolve-file-list", async (): Promise<VaultCandidate[]> => {
      if (input.changedPaths && input.changedPaths.length > 0) {
        return input.changedPaths.filter((p) => p.endsWith(".md")).map((path) => ({ path, sha: null }));
      }
      const entries = await fetchRepoMarkdownFiles(ctx, owner, repo, branch);
      return entries.map((e) => ({ path: e.path, sha: e.sha }));
    });

    // ── Step 2: Load the whole vault index in ONE request ──────────────────────
    const indexRows = await step(ctx, "load-index", async () => {
      const res = await ctx.fetch(
        `${ctx.env.SUPABASE_URL}/rest/v1/orch_documents?source_kind=eq.vault&select=id,source_uri,metadata`,
        { headers: sbHeaders(ctx.env, { profile: "orchestration" }) },
      );
      if (!res.ok) throw new Error(`vault index load → ${res.status}: ${await res.text()}`);
      const rows = (await res.json()) as Array<{ id: string; source_uri: string; metadata: Record<string, unknown> | null }>;
      return rows.map((r) => ({ id: r.id, sourceUri: r.source_uri, blobSha: (r.metadata?.["github_blob_sha"] as string | undefined) ?? null }));
    });
    const index = new Map(indexRows.map((r) => [r.sourceUri, { id: r.id, blobSha: r.blobSha }]));

    const sourceUriFor = (path: string) => vaultSourceUri(owner, repo, path);
    const selection = selectVaultFiles(candidates, index, sourceUriFor);

    // ── Step 3: Embed the selected files ──────────────────────────────────────
    let ingested = 0;
    let skipped  = selection.unchanged;
    const errors: string[] = [];

    if (selection.toIngest.length > 0) {
      const result = await step(ctx, "ingest", async () => {
        let batchIngested = 0;
        let batchSkipped  = 0;
        const batchErrors: string[] = [];

        for (const f of selection.toIngest) {
          try {
            const file = await fetchFileContent(ctx, owner, repo, f.path);
            if (file.content.trim().length === 0) {
              batchSkipped++;
              continue;
            }
            const { ingested: wasIngested } = await upsertVaultDocument(ctx.env, {
              sourceUri:  sourceUriFor(f.path),
              sourceName: f.path.split("/").pop() ?? f.path,
              content:    file.content,
              blobSha:    file.blobSha,
              existing:   f.existing,
              metadata: {
                vault_path:   f.path,
                vault_repo:   `${owner}/${repo}`,
                vault_branch: branch,
                folder: f.path.includes("/") ? f.path.split("/").slice(0, -1).join("/") : "/",
              },
            });
            if (wasIngested) batchIngested++;
            else batchSkipped++;
          } catch (err) {
            batchErrors.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return { batchIngested, batchSkipped, batchErrors };
      });
      ingested += result.batchIngested;
      skipped  += result.batchSkipped;
      errors.push(...result.batchErrors);
    }

    // ── Final step: Remove deleted files ─────────────────────────────────────
    let removed = 0;
    if (input.removedPaths && input.removedPaths.length > 0) {
      const mdRemoved = input.removedPaths.filter((p) => p.endsWith(".md"));
      removed = await step(ctx, "remove-deleted-files", async () => {
        let count = 0;
        for (const filePath of mdRemoved) {
          try {
            await removeVaultDocument(ctx.env, vaultSourceUri(owner, repo, filePath));
            count++;
          } catch (err) {
            errors.push(`remove ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return count;
      });
    }

    return { ingested, skipped, remaining: selection.remaining, removed, errors };
  },
});
