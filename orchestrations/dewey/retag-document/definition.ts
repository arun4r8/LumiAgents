import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import type { Env } from "@/runtime";

// Dewey's curatorial power: move a document between corpora and set its sensitivity.
// This is how a document gets locked down (sensitivity='restricted', ops-only) or
// handed to a specific agent's private corpus. Ops-only, since it changes who can read what.

export const inputSchema = z.object({
  documentId: z.string().uuid().describe("orch_documents.id of the document to re-tag."),
  corpus: z.string().optional().describe("New corpus: 'shared' (every agent) or an agent slug for a private corpus."),
  sensitivity: z.enum(["internal", "restricted"]).optional().describe("New sensitivity: 'internal' (team-usable) or 'restricted' (ops-only)."),
});

export const outputSchema = z.object({
  documentId: z.string().uuid(),
  sourceName: z.string(),
  corpus: z.string(),
  sensitivity: z.string(),
});

function headers(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Profile": "orchestration",
    "Accept-Profile": "orchestration",
    ...extra,
  };
}

export default defineOrchestration({
  name: "dewey/retag-document",
  version: 1,
  triggerMode: "agent",
  description:
    "Re-tag a document's corpus and/or sensitivity. Dewey's curation of the knowledge base (e.g. lock a doc to 'restricted', or move it to an agent's private corpus).",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },
  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const env = ctx.env;
    if (input.corpus === undefined && input.sensitivity === undefined) {
      throw new Error("Nothing to change. Provide corpus and/or sensitivity.");
    }

    return step(ctx, "retag", async () => {
      const patch: Record<string, string> = {};
      if (input.corpus !== undefined) patch["corpus"] = input.corpus;
      if (input.sensitivity !== undefined) patch["sensitivity"] = input.sensitivity;

      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/orch_documents?id=eq.${encodeURIComponent(input.documentId)}`,
        { method: "PATCH", headers: headers(env, { Prefer: "return=representation" }), body: JSON.stringify(patch) },
      );
      if (!res.ok) throw new Error(`Supabase PATCH orch_documents → ${res.status}: ${await res.text()}`);
      const rows = (await res.json()) as Array<{ id: string; source_name: string; corpus: string; sensitivity: string }>;
      const row = rows[0];
      if (!row) throw new Error(`No document found for id ${input.documentId}`);
      return { documentId: row.id, sourceName: row.source_name, corpus: row.corpus, sensitivity: row.sensitivity };
    });
  },
});
