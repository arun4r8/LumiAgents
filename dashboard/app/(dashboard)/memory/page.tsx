import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { MemoryClient } from "@/components/memory-client";

export const dynamic = "force-dynamic";

export interface ConversationSummary {
  id: string;
  agent_slug: string;
  user_id: string | null;
  title: string | null;
  last_message_at: string;
  created_at: string;
  messageCount: number;
  memoryCount: number;
}

export interface MemoryMessage { id: string; role: string; content: string; created_at: string }
export interface MemoryChunk { id: string; kind: string; content: string; created_at: string }

export default async function MemoryPage() {
  const supabase = await createClient();

  const { data } = await supabase
    .schema("orchestration")
    .from("conversations")
    .select("id,agent_slug,user_id,title,last_message_at,created_at,messages(count),memory_chunks(count)")
    .order("last_message_at", { ascending: false })
    .limit(200);

  const conversations: ConversationSummary[] = (data ?? []).map((c: Record<string, unknown>) => ({
    id: c.id as string,
    agent_slug: c.agent_slug as string,
    user_id: (c.user_id as string | null) ?? null,
    title: (c.title as string | null) ?? null,
    last_message_at: c.last_message_at as string,
    created_at: c.created_at as string,
    messageCount: ((c.messages as { count: number }[] | undefined)?.[0]?.count) ?? 0,
    memoryCount: ((c.memory_chunks as { count: number }[] | undefined)?.[0]?.count) ?? 0,
  }));

  // Load a conversation's transcript + memory chunks on demand (expand).
  async function loadDetail(conversationId: string): Promise<{ messages: MemoryMessage[]; chunks: MemoryChunk[] }> {
    "use server";
    const supabase = await createClient();
    const { data: messages } = await supabase
      .schema("orchestration").from("messages")
      .select("id,role,content,created_at").eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    const { data: chunks } = await supabase
      .schema("orchestration").from("memory_chunks")
      .select("id,kind,content,created_at").eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    return { messages: (messages ?? []) as MemoryMessage[], chunks: (chunks ?? []) as MemoryChunk[] };
  }

  // Forget an entire conversation (cascades to its messages + memory chunks).
  async function forgetConversation(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const id = formData.get("id") as string;
    const { error } = await supabase.schema("orchestration").from("conversations").delete().eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/memory");
  }

  // Forget a single memory item (a fact or summary).
  async function forgetChunk(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const id = formData.get("id") as string;
    const { error } = await supabase.schema("orchestration").from("memory_chunks").delete().eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/memory");
  }

  return (
    <MemoryClient
      conversations={conversations}
      loadDetail={loadDetail}
      forgetConversation={forgetConversation}
      forgetChunk={forgetChunk}
    />
  );
}
