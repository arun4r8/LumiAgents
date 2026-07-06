import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { RfiDraftsClient } from "@/components/rfi-drafts-client";

export const dynamic = "force-dynamic";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

export interface RfiDraft {
  id: string;
  sam_notice_id: string | null;
  opportunity_title: string | null;
  agency: string | null;
  notice_type: string | null;
  response_deadline: string | null;
  draft_markdown: string;
  model: string | null;
  created_at: string;
}

export interface OppOption {
  sam_notice_id: string;
  title: string | null;
  notice_type: string | null;
  agency: string | null;
  response_deadline: string | null;
}

async function getToken(): Promise<string> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("No active session");
  return session.access_token;
}

export default async function RfiDraftsPage() {
  const supabase = await createClient();

  const { data: drafts } = await supabase
    .from("rfi_drafts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  // SAM opportunities you can draft a response for (RFIs/Sources Sought come from SAM).
  const { data: opps } = await supabase
    .from("opportunities")
    .select("sam_notice_id,title,notice_type,agency,response_deadline")
    .eq("source", "sam_gov")
    .order("response_deadline", { ascending: true, nullsFirst: false })
    .limit(60);

  // Trigger a draft: fires cleo/rfi-draft (async) — it lands in rfi_drafts.
  async function generateDraft(formData: FormData) {
    "use server";
    const samNoticeId = formData.get("samNoticeId") as string;
    if (!samNoticeId) throw new Error("Pick an opportunity first.");
    const token = await getToken();
    const res = await fetch(
      `${RUNTIME}/api/orchestrations/${encodeURIComponent("cleo/rfi-draft")}/run`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ samNoticeId }),
      },
    );
    if (!res.ok) throw new Error(`Draft failed (${res.status}): ${await res.text()}`);
    revalidatePath("/rfi-drafts");
  }

  async function deleteDraft(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const id = formData.get("id") as string;
    const { error } = await supabase.from("rfi_drafts").delete().eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/rfi-drafts");
  }

  return (
    <RfiDraftsClient
      drafts={(drafts ?? []) as RfiDraft[]}
      opportunities={(opps ?? []) as OppOption[]}
      generateDraft={generateDraft}
      deleteDraft={deleteDraft}
    />
  );
}
