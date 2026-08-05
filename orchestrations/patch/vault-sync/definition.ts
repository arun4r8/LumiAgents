import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { fetchFileContent, fetchRepoMarkdownFiles } from "../../../integrations/github/files";
import { upsertVaultDocument, removeVaultDocument } from "../../../runtime/src/agents/vault-sync";
import { vaultSourceUri } from "../../../integrations/github/base";

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
  removed:  z.number().describe("Files removed from the RAG index"),
  errors:   z.array(z.string()),
});

const BATCH_SIZE = 20;

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

    // ── Step 1: Resolve the file list ─────────────────────────────────────────
    const filePaths = await step(ctx, "resolve-file-list", async () => {
      if (input.changedPaths && input.changedPaths.length > 0) {
        return input.changedPaths.filter((p) => p.endsWith(".md"));
      }
      const entries = await fetchRepoMarkdownFiles(ctx, owner, repo, branch);
      return entries.map((e) => e.path);
    });

    // ── Step 2+: Ingest files in batches of BATCH_SIZE ───────────────────────
    let ingested = 0;
    let skipped  = 0;
    const errors: string[] = [];

    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
      const batch = filePaths.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      const result = await step(ctx, `ingest-batch-${batchNum}`, async () => {
        let batchIngested = 0;
        let batchSkipped  = 0;
        const batchErrors: string[] = [];

        for (const filePath of batch) {
          try {
            const file = await fetchFileContent(ctx, owner, repo, filePath);
            if (file.content.trim().length === 0) {
              batchSkipped++;
              continue;
            }

            const sourceUri  = vaultSourceUri(owner, repo, filePath);
            const sourceName = filePath.split("/").pop() ?? filePath;

            const { ingested: wasIngested } = await upsertVaultDocument(ctx.env, {
              sourceUri,
              sourceName,
              content:  file.content,
              blobSha:  file.blobSha,
              metadata: {
                vault_path:  filePath,
                vault_repo:  `${owner}/${repo}`,
                vault_branch: branch,
                folder: filePath.includes("/") ? filePath.split("/").slice(0, -1).join("/") : "/",
              },
            });

            if (wasIngested) batchIngested++;
            else batchSkipped++;
          } catch (err) {
            batchErrors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
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

    return { ingested, skipped, removed, errors };
  },
});
