import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { DocumentsClient } from "@/components/documents-client";

export const dynamic = "force-dynamic";

interface OrcDocument {
  id: string;
  source_name: string;
  source_kind: string;
  char_count: number | null;
  created_at: string;
  chunk_count?: number;
}

interface CorpusDoc {
  id: string;
  source_name: string;
  source_kind: string;
  source_uri: string | null;
  metadata: Record<string, unknown>;
  char_count: number | null;
  chunk_count: number;
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

export default async function DocumentsPage() {
  const supabase = await createClient();

  const { data: docs } = await supabase
    .schema("orchestration")
    .from("orch_documents")
    .select("id, source_name, source_kind, char_count, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  // Fetch richer corpus list from the runtime (includes chunk counts)
  let corpusDocs: CorpusDoc[] = [];
  try {
    const token = await getToken();
    if (token) {
      const res = await fetch(`${RUNTIME}/api/documents`, {
        headers: { Authorization: `Bearer ${token}` },
        // Next.js server fetch — opt out of caching for fresh data
        cache: "no-store",
      });
      if (res.ok) {
        corpusDocs = await res.json() as CorpusDoc[];
      }
    }
  } catch {
    // Gracefully degrade — corpus tab shows empty state
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
    revalidatePath("/documents");
  }

  return (
    <DocumentsClient
      documents={(docs ?? []) as OrcDocument[]}
      corpusDocs={corpusDocs}
      deleteDocument={deleteDocument}
    />
  );
}
