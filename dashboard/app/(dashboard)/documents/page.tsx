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

export default async function DocumentsPage() {
  const supabase = await createClient();

  const { data: docs } = await supabase
    .schema("orchestration")
    .from("orch_documents")
    .select("id, source_name, source_kind, char_count, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  async function deleteDocument(id: string) {
    "use server";
    const sb = await createClient();
    await sb.schema("orchestration").from("orch_documents").delete().eq("id", id);
    revalidatePath("/documents");
  }

  return (
    <DocumentsClient
      documents={(docs ?? []) as OrcDocument[]}
      deleteDocument={deleteDocument}
    />
  );
}
