import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { ReportsClient } from "@/components/reports-client";

export const dynamic = "force-dynamic";

// Email is "configured" once the runtime has a Resend key + verified domain.
// The dashboard can't read runtime secrets, so this is surfaced via a public env
// flag the operator flips when they finish Resend setup. Defaults to "not configured"
// so the warning banner shows until then.
const EMAIL_CONFIGURED = process.env.NEXT_PUBLIC_EMAIL_CONFIGURED === "true";

interface Subscription {
  id: string;
  label: string | null;
  cadence: "daily" | "weekly";
  recipients: string[];
  min_fit_score: number;
  is_active: boolean;
  last_sent_at: string | null;
  created_at: string;
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function clampScore(raw: FormDataEntryValue | null): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 7;
  return Math.min(10, Math.max(1, n));
}

export default async function ReportsPage() {
  const supabase = await createClient();

  const { data: subscriptions } = await supabase
    .schema("orchestration")
    .from("report_subscriptions")
    .select("*")
    .order("created_at", { ascending: true });

  async function createSubscription(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    const recipients = parseRecipients((formData.get("recipients") as string) ?? "");
    if (recipients.length === 0) throw new Error("At least one recipient email is required.");

    const cadence = formData.get("cadence") === "daily" ? "daily" : "weekly";

    const { error } = await supabase
      .schema("orchestration")
      .from("report_subscriptions")
      .insert({
        user_id: user?.id ?? null,
        label: (formData.get("label") as string)?.trim() || null,
        cadence,
        recipients,
        min_fit_score: clampScore(formData.get("min_fit_score")),
        is_active: true,
      });
    if (error) throw new Error(error.message);
    revalidatePath("/reports");
  }

  async function toggleSubscription(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const id = formData.get("id") as string;
    const currentlyActive = formData.get("is_active") === "true";
    const { error } = await supabase
      .schema("orchestration")
      .from("report_subscriptions")
      .update({ is_active: !currentlyActive, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/reports");
  }

  async function deleteSubscription(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const id = formData.get("id") as string;
    const { error } = await supabase
      .schema("orchestration")
      .from("report_subscriptions")
      .delete()
      .eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/reports");
  }

  async function updateSubscription(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const id = formData.get("id") as string;

    const recipients = parseRecipients((formData.get("recipients") as string) ?? "");
    if (recipients.length === 0) throw new Error("At least one recipient email is required.");

    const cadence = formData.get("cadence") === "daily" ? "daily" : "weekly";

    const { error } = await supabase
      .schema("orchestration")
      .from("report_subscriptions")
      .update({
        label: (formData.get("label") as string)?.trim() || null,
        cadence,
        recipients,
        min_fit_score: clampScore(formData.get("min_fit_score")),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/reports");
  }

  return (
    <ReportsClient
      subscriptions={(subscriptions ?? []) as Subscription[]}
      emailConfigured={EMAIL_CONFIGURED}
      createSubscription={createSubscription}
      toggleSubscription={toggleSubscription}
      deleteSubscription={deleteSubscription}
      updateSubscription={updateSubscription}
    />
  );
}
