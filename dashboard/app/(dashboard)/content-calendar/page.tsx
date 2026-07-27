import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { ContentCalendarClient } from "@/components/content-calendar-client";
import { mapContentCsv } from "@/lib/content-csv";

export const dynamic = "force-dynamic";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

export interface CalendarEntry {
  id: string;
  release_date: string | null;
  topic: string;
  channel: string;
  asset_type: string | null;
  asset_ref: string | null;
  description: string | null;
  draft_markdown: string | null;
  status: "idea" | "drafting" | "ready" | "scheduled" | "posted";
  owner: string | null;
  updated_at: string;
}

const STATUSES = ["idea", "drafting", "ready", "scheduled", "posted"] as const;

function str(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length > 0 ? s : null;
}

async function getToken(): Promise<string> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("No active session");
  return session.access_token;
}

export default async function ContentCalendarPage() {
  const supabase = await createClient();

  const { data: entries } = await supabase
    .from("content_calendar")
    .select("*")
    .order("release_date", { ascending: true, nullsFirst: false });

  async function createEntry(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const topic = str(formData.get("topic"));
    if (!topic) throw new Error("Topic is required.");
    const { error } = await supabase.from("content_calendar").insert({
      topic,
      release_date: str(formData.get("release_date")),
      channel: str(formData.get("channel")) ?? "linkedin",
      asset_type: str(formData.get("asset_type")),
      asset_ref: str(formData.get("asset_ref")),
      description: str(formData.get("description")),
      owner: str(formData.get("owner")),
      status: "idea",
    });
    if (error) throw new Error(error.message);
    revalidatePath("/content-calendar");
  }

  async function updateEntry(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const id = formData.get("id") as string;
    const { error } = await supabase
      .from("content_calendar")
      .update({
        topic: str(formData.get("topic")) ?? "Untitled",
        release_date: str(formData.get("release_date")),
        channel: str(formData.get("channel")) ?? "linkedin",
        asset_type: str(formData.get("asset_type")),
        asset_ref: str(formData.get("asset_ref")),
        description: str(formData.get("description")),
        owner: str(formData.get("owner")),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/content-calendar");
  }

  async function setStatus(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const id = formData.get("id") as string;
    const status = String(formData.get("status") ?? "");
    if (!(STATUSES as readonly string[]).includes(status)) throw new Error("Invalid status.");
    const { error } = await supabase
      .from("content_calendar")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/content-calendar");
  }

  async function deleteEntry(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const id = formData.get("id") as string;
    const { error } = await supabase.from("content_calendar").delete().eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/content-calendar");
  }

  // Draft with Cleo: fires cleo/content-draft (async); the draft lands back on the row.
  async function draftWithCleo(formData: FormData): Promise<void> {
    "use server";
    const id = formData.get("id") as string;
    const token = await getToken();
    const res = await fetch(
      `${RUNTIME}/api/orchestrations/${encodeURIComponent("cleo/content-draft")}/run`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ calendarId: id }),
      },
    );
    if (!res.ok) throw new Error(`Draft failed (${res.status}): ${await res.text()}`);
    // Optimistically show it's being worked on.
    const supabase = await createClient();
    await supabase.from("content_calendar").update({ status: "drafting" }).eq("id", id);
    revalidatePath("/content-calendar");
  }

  // Plan with Cleo: fires cleo/content-plan (async); seeds idea rows from a theme.
  async function planWithCleo(formData: FormData): Promise<void> {
    "use server";
    const theme = str(formData.get("theme"));
    if (!theme) throw new Error("A theme is required.");
    const count = Math.min(20, Math.max(1, Math.round(Number(formData.get("count")) || 5)));
    const token = await getToken();
    const res = await fetch(
      `${RUNTIME}/api/orchestrations/${encodeURIComponent("cleo/content-plan")}/run`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ theme, count, startDate: str(formData.get("startDate")) ?? undefined }),
      },
    );
    if (!res.ok) throw new Error(`Plan failed (${res.status}): ${await res.text()}`);
    revalidatePath("/content-calendar");
  }

  // Sync now: fire cleo/content-sync (async) to live-sync the calendar from the
  // team's Microsoft 365 planning workbook via the Graph API. Runs in the
  // background; synced rows land here (idempotent via source_key — same keys as
  // an equivalent CSV import, and existing drafts/status are preserved). Surfaces
  // the runtime error (e.g. "not configured") if the run can't be started.
  async function syncNow(): Promise<{ started: boolean }> {
    "use server";
    const token = await getToken();
    const res = await fetch(
      `${RUNTIME}/api/orchestrations/${encodeURIComponent("cleo/content-sync")}/run`,
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({}) },
    );
    if (!res.ok) throw new Error(`Sync failed (${res.status}): ${await res.text()}`);
    revalidatePath("/content-calendar");
    return { started: true };
  }

  // Import CSV (from the team's planning spreadsheet). Idempotent via source_key:
  // re-uploading an edited sheet updates rows; existing drafts/status are preserved
  // (they aren't in the upsert payload).
  async function importCsv(formData: FormData): Promise<{ imported: number; skipped: number }> {
    "use server";
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a CSV file to import.");
    const text = await file.text();
    const { rows, skipped } = mapContentCsv(text, new Date().getFullYear());
    if (rows.length === 0) throw new Error("No rows found. The CSV needs a header row with at least a Topic column.");

    const supabase = await createClient();
    const { error } = await supabase.from("content_calendar").upsert(rows, { onConflict: "source_key" });
    if (error) throw new Error(error.message);
    revalidatePath("/content-calendar");
    return { imported: rows.length, skipped };
  }

  return (
    <ContentCalendarClient
      entries={(entries ?? []) as CalendarEntry[]}
      createEntry={createEntry}
      updateEntry={updateEntry}
      setStatus={setStatus}
      deleteEntry={deleteEntry}
      draftWithCleo={draftWithCleo}
      planWithCleo={planWithCleo}
      importCsv={importCsv}
      syncNow={syncNow}
    />
  );
}
