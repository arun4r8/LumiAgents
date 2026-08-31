import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { KnowledgeClient } from "@/components/knowledge-client";
import { roleOf } from "@/lib/role";
import type { OrcDocument, CorpusDoc } from "@/components/document-corpus";

export const dynamic = "force-dynamic";

interface VaultRun {
  id: string;
  status: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  started_at: string;
  ended_at: string | null;
  triggered_by: string;
}

interface VaultDoc {
  id: string;
  source_name: string;
  source_uri: string | null;
  created_at: string;
}

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

async function getToken(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

type KnowledgeTab = "editor" | "sync" | "corpus";

// The /documents redirect lands here with ?tab=corpus so old bookmarks open on
// the merged Document Corpus tab they expected.
function initialTabFrom(raw: string | undefined): KnowledgeTab {
  return raw === "sync" || raw === "corpus" ? raw : "editor";
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const isOps = roleOf(user) === "ops";

  // Get the vault-sync orchestration ID
  const { data: orchRow } = await supabase
    .schema("orchestration")
    .from("orchestrations")
    .select("id")
    .eq("name", "patch/vault-sync")
    .single();

  const [runsRes, docsRes, corpusRes] = await Promise.all([
    orchRow
      ? supabase
          .schema("orchestration")
          .from("runs")
          .select("id, status, input, output, started_at, ended_at, triggered_by")
          .eq("orchestration_id", orchRow.id)
          .order("started_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] }),

    // Vault notes for the Sync tab's "Indexed notes" list.
    supabase
      .schema("orchestration")
      .from("orch_documents")
      .select("id, source_name, source_uri, created_at")
      .eq("source_kind", "vault")
      .order("created_at", { ascending: false })
      .limit(200),

    // The full corpus (vault + uploaded) for the Document Corpus tab's browser.
    supabase
      .schema("orchestration")
      .from("orch_documents")
      .select("id, source_name, source_kind, char_count, created_at")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  // Richer corpus list from the runtime (includes chunk counts and source_uri,
  // which is what lets us tell vault-synced docs apart from uploads).
  let corpusDocs: CorpusDoc[] = [];
  try {
    const token = await getToken();
    if (token) {
      const res = await fetch(`${RUNTIME}/api/documents`, {
        headers: { Authorization: `Bearer ${token}` },
        // Next.js server fetch: opt out of caching for fresh data
        cache: "no-store",
      });
      if (res.ok) {
        corpusDocs = await res.json() as CorpusDoc[];
      }
    }
  } catch {
    // Gracefully degrade: corpus browser falls back to the Supabase list
  }

  async function deleteDocument(id: string) {
    "use server";
    // Delete via runtime so it is consistent with the runtime's auth model.
    // Falls back to direct Supabase delete if token is unavailable.
    const token = await getToken();
    if (token) {
      await fetch(`${RUNTIME}/api/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } else {
      const sb = await createClient();
      await sb.schema("orchestration").from("orch_documents").delete().eq("id", id);
    }
    // Corpus browser now lives under /knowledge, so revalidate here.
    revalidatePath("/knowledge");
  }

  return (
    <KnowledgeClient
      recentRuns={(runsRes.data ?? []) as VaultRun[]}
      vaultDocs={(docsRes.data ?? []) as VaultDoc[]}
      documents={(corpusRes.data ?? []) as OrcDocument[]}
      corpusDocs={corpusDocs}
      deleteDocument={deleteDocument}
      isOps={isOps}
      initialTab={isOps ? initialTabFrom(tab) : "corpus"}
    />
  );
}
