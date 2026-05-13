import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { SchedulesClient } from "@/components/schedules-client";

export const dynamic = "force-dynamic";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

interface Schedule {
  id: string;
  orchestration_name: string;
  label: string | null;
  cron_expression: string;
  is_active: boolean;
  default_input: Record<string, unknown>;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

async function getToken(): Promise<string> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("No active session");
  return session.access_token;
}

export default async function SchedulesPage() {
  const supabase = await createClient();

  const { data: schedules } = await supabase
    .schema("orchestration")
    .from("schedules")
    .select("*")
    .order("created_at", { ascending: true });

  async function createSchedule(formData: FormData) {
    "use server";
    const token = await getToken();
    const res = await fetch(`${RUNTIME}/api/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        orchestration_name: formData.get("orchestration_name"),
        cron_expression: formData.get("cron_expression"),
        label: (formData.get("label") as string)?.trim() || undefined,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    revalidatePath("/schedules");
  }

  async function toggleSchedule(formData: FormData) {
    "use server";
    const token = await getToken();
    const id = formData.get("id") as string;
    const currentlyActive = formData.get("is_active") === "true";
    const res = await fetch(`${RUNTIME}/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ is_active: !currentlyActive }),
    });
    if (!res.ok) throw new Error(await res.text());
    revalidatePath("/schedules");
  }

  async function deleteSchedule(formData: FormData) {
    "use server";
    const token = await getToken();
    const id = formData.get("id") as string;
    const res = await fetch(`${RUNTIME}/api/schedules/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(await res.text());
    revalidatePath("/schedules");
  }

  return (
    <SchedulesClient
      schedules={(schedules ?? []) as Schedule[]}
      createSchedule={createSchedule}
      toggleSchedule={toggleSchedule}
      deleteSchedule={deleteSchedule}
    />
  );
}
