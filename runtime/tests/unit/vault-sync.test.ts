import { describe, it, expect, afterEach, vi } from "vitest";
import { upsertVaultDocument } from "../../src/agents/vault-sync";
import {
  selectVaultFiles,
  MAX_VAULT_FILES_PER_RUN,
  type IndexedDoc,
} from "../../../orchestrations/patch/vault-sync/definition";
import {
  WORKER_SUBREQUEST_LIMIT,
  SUBREQUESTS_PER_STEP,
} from "../../src/config/limits";

/**
 * patch/vault-sync had never completed a run (#181). Registering it was necessary
 * and not sufficient: its Supabase calls had no schema header and one dotted path,
 * so even a registered run would have failed on its first query. These pin the
 * request shape, the change detection, and the subrequest budget.
 */

const uri = (p: string) => `github:LumitureLabs/LumiKnowledge:${p}`;

describe("upsertVaultDocument: schema by header, never by path", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("addresses the orchestration schema with profile headers on every Supabase call", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      const body = String(url).includes("/orch_documents") && init?.method === "POST" ? [{ id: "doc-1" }] : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const env = {
      SUPABASE_URL: "https://db.example",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      AI: { run: async (_m: string, i: { text: string[] }) => ({ data: i.text.map(() => [0.1, 0.2]) }) },
    } as never;

    await upsertVaultDocument(env, {
      // A realistic note: long enough to chunk. The first draft used "hello vault",
      // which produces no chunks -- so the chunk insert, the call this test exists to
      // check, never ran, and a dotted chunk path would have passed.
      sourceUri: uri("Notes/a.md"), sourceName: "a.md", content: "Lumiture past performance notes. ".repeat(120), blobSha: "sha-1",
      metadata: {}, existing: { id: "old", blobSha: "sha-0" },
    });

    const supabase = calls.filter((c) => c.url.startsWith("https://db.example"));
    expect(supabase.length).toBeGreaterThanOrEqual(3); // delete old, insert doc, insert chunks
    for (const c of supabase) {
      expect(c.url).not.toMatch(/\/orchestration\./);
      expect(c.headers["Accept-Profile"]).toBe("orchestration");
      expect(c.headers["Content-Profile"]).toBe("orchestration");
    }
    // The chunk insert must actually have happened, or every assertion above is vacuous for it.
    expect(supabase.filter((c) => c.url.endsWith("/rest/v1/document_chunks"))).not.toHaveLength(0);
  });

  it("skips the lookup entirely when the caller supplies the index row", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response("[]", { status: 200 });
    }));
    const res = await upsertVaultDocument({ SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "k" } as never, {
      sourceUri: uri("x.md"), sourceName: "x.md", content: "c", blobSha: "same", metadata: {},
      existing: { id: "doc-9", blobSha: "same" },
    });
    expect(res).toEqual({ ingested: false, documentId: "doc-9" });
    expect(calls).toHaveLength(0);
  });
});

describe("selectVaultFiles", () => {
  const index = new Map<string, IndexedDoc>([
    [uri("same.md"), { id: "d1", blobSha: "s1" }],
    [uri("edited.md"), { id: "d2", blobSha: "old" }],
  ]);

  it("skips unchanged files by tree SHA, before any fetch", () => {
    const r = selectVaultFiles([{ path: "same.md", sha: "s1" }], index, uri);
    expect(r.toIngest).toHaveLength(0);
    expect(r.unchanged).toBe(1);
  });

  it("takes new and edited files, carrying the index row for edits", () => {
    const r = selectVaultFiles([{ path: "new.md", sha: "n1" }, { path: "edited.md", sha: "new" }], index, uri);
    expect(r.toIngest.map((f) => f.path)).toEqual(["new.md", "edited.md"]);
    expect(r.toIngest[0]!.existing).toBeNull();
    expect(r.toIngest[1]!.existing).toEqual({ id: "d2", blobSha: "old" });
  });

  it("treats a SHA-less path (from a webhook) as possibly changed", () => {
    const r = selectVaultFiles([{ path: "same.md", sha: null }], index, uri);
    expect(r.toIngest).toHaveLength(1);
  });

  it("caps a run and reports what is left, in order", () => {
    const many = Array.from({ length: MAX_VAULT_FILES_PER_RUN + 2 }, (_, i) => ({ path: `n${i}.md`, sha: `s${i}` }));
    const r = selectVaultFiles(many, new Map(), uri);
    expect(r.toIngest).toHaveLength(MAX_VAULT_FILES_PER_RUN);
    expect(r.toIngest[0]!.path).toBe("n0.md");
    expect(r.remaining).toBe(2);
  });
});

describe("vault-sync subrequest budget", () => {
  const PER_FILE = 5; // contents fetch, delete old row, insert doc, insert chunks, embed
  function projected(files: number): number {
    return (
      3 +                                   // workflow entry
      SUBREQUESTS_PER_STEP + 1 +            // resolve-file-list: one tree request
      SUBREQUESTS_PER_STEP + 1 +            // load-index: one request for the whole index
      SUBREQUESTS_PER_STEP + files * PER_FILE // ingest
    );
  }

  it("fits at the per-run cap, with headroom", () => {
    expect(WORKER_SUBREQUEST_LIMIT - projected(MAX_VAULT_FILES_PER_RUN)).toBeGreaterThanOrEqual(5);
  });

  it("would not fit uncapped for the 8-note vault with a lookup per file (the old shape)", () => {
    const oldShape = 3 + SUBREQUESTS_PER_STEP + 1 + SUBREQUESTS_PER_STEP + 8 * (PER_FILE + 1);
    expect(oldShape).toBeGreaterThan(WORKER_SUBREQUEST_LIMIT);
  });
});
