import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import type { Env } from "@/runtime";

// Dewey's librarian overview: what's in the knowledge base, broken down by corpus
// and sensitivity, so ops can see coverage and spot documents that should be locked
// down or moved. Read-only.

export const inputSchema = z.object({});

export const outputSchema = z.object({
  totalDocuments: z.number(),
  byCorpus: z.array(z.object({ corpus: z.string(), count: z.number() })),
  bySensitivity: z.array(z.object({ sensitivity: z.string(), count: z.number() })),
  recent: z.array(z.object({ documentId: z.string(), sourceName: z.string(), corpus: z.string(), sensitivity: z.string() })),
});

function headers(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Accept-Profile": "orchestration",
  };
}

export default defineOrchestration({
  name: "dewey/knowledge-inventory",
  version: 1,
  triggerMode: "agent",
  description:
    "Summarize the shared knowledge base: document counts by corpus and sensitivity, plus the most recent documents. Dewey's librarian overview.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },
  async run(ctx): Promise<z.infer<typeof outputSchema>> {
    const env = ctx.env;
    return step(ctx, "inventory", async () => {
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/orch_documents?select=id,source_name,corpus,sensitivity,created_at&order=created_at.desc`,
        { headers: headers(env) },
      );
      if (!res.ok) throw new Error(`Supabase GET orch_documents → ${res.status}: ${await res.text()}`);
      const docs = (await res.json()) as Array<{ id: string; source_name: string; corpus: string; sensitivity: string }>;

      const tally = (key: "corpus" | "sensitivity") => {
        const m = new Map<string, number>();
        for (const d of docs) m.set(d[key], (m.get(d[key]) ?? 0) + 1);
        return [...m.entries()].map(([k, count]) => ({ [key]: k, count })) as Array<Record<string, string | number>>;
      };

      return {
        totalDocuments: docs.length,
        byCorpus: tally("corpus") as Array<{ corpus: string; count: number }>,
        bySensitivity: tally("sensitivity") as Array<{ sensitivity: string; count: number }>,
        recent: docs.slice(0, 10).map((d) => ({ documentId: d.id, sourceName: d.source_name, corpus: d.corpus, sensitivity: d.sensitivity })),
      };
    });
  },
});
