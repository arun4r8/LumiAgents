import { createClient } from "@/lib/supabase/server";
import { KnowledgeClient } from "@/components/knowledge-client";

export const dynamic = "force-dynamic";

interface VaultRun {
  id: string;
  status: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  started_at: string;
  completed_at: string | null;
  triggered_by: string;
}

interface VaultDoc {
  id: string;
  source_name: string;
  source_uri: string | null;
  created_at: string;
}

export default async function KnowledgePage() {
  const supabase = await createClient();

  // Get the vault-sync orchestration ID
  const { data: orchRow } = await supabase
    .schema("orchestration")
    .from("orchestrations")
    .select("id")
    .eq("name", "patch/vault-sync")
    .single();

  const [runsRes, docsRes] = await Promise.all([
    orchRow
      ? supabase
          .schema("orchestration")
          .from("runs")
          .select("id, status, input, output, started_at, completed_at, triggered_by")
          .eq("orchestration_id", orchRow.id)
          .order("started_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] }),

    supabase
      .schema("orchestration")
      .from("orch_documents")
      .select("id, source_name, source_uri, created_at")
      .eq("source_kind", "vault")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  async function triggerManualSync(repoOwner: string, repoName: string) {
    "use server";
    // Handled client-side via /api/vault/sync to carry the user's auth token.
    return { runId: "" };
  }

  return (
    <KnowledgeClient
      recentRuns={(runsRes.data ?? []) as VaultRun[]}
      vaultDocs={(docsRes.data ?? []) as VaultDoc[]}
      triggerManualSync={triggerManualSync}
    />
  );
}
