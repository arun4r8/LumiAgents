import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { ReportsClient } from "@/components/reports-client";

export const dynamic = "force-dynamic";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

// Email is "configured" once the runtime has a Resend key + verified domain.
// The dashboard can't read runtime secrets, so this is surfaced via a public env
// flag the operator flips when they finish Resend setup. Defaults to "not configured"
// so the warning banner shows until then.
const EMAIL_CONFIGURED = process.env.NEXT_PUBLIC_EMAIL_CONFIGURED === "true";

const VALID_SOURCES = ["sam_gov", "sbir"] as const;

interface Subscription {
  id: string;
  label: string | null;
  cadence: "daily" | "weekly";
  recipients: string[];
  min_fit_score: number;
  is_active: boolean;
  last_sent_at: string | null;
  sources: string[] | null;
  agencies: string[] | null;
  set_asides: string[] | null;
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

// Comma-separated free text → trimmed array (case preserved); empty → null.
function parseList(raw: FormDataEntryValue | null): string[] | null {
  const items = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : null;
}

function parseSources(formData: FormData): string[] | null {
  const picked = formData.getAll("sources").map(String).filter((s) => (VALID_SOURCES as readonly string[]).includes(s));
  return picked.length > 0 ? picked : null;
}

function clampScore(raw: FormDataEntryValue | null): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 7;
  return Math.min(10, Math.max(1, n));
}

async function getToken(): Promise<string> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("No active session");
  return session.access_token;
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
        sources: parseSources(formData),
        agencies: parseList(formData.get("agencies")),
        set_asides: parseList(formData.get("set_asides")),
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
        sources: parseSources(formData),
        agencies: parseList(formData.get("agencies")),
        set_asides: parseList(formData.get("set_asides")),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/reports");
  }

  // "Send now": trigger the report orchestration for one subscription immediately,
  // bypassing cadence. Runs through the authenticated runtime endpoint (ops-gated).
  async function sendNow(formData: FormData): Promise<void> {
    "use server";
    const id = formData.get("id") as string;
    const token = await getToken();
    const res = await fetch(
      `${RUNTIME}/api/orchestrations/${encodeURIComponent("beady/opportunity-report")}/run`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ subscriptionId: id }),
      },
    );
    if (!res.ok) throw new Error(`Send failed (${res.status}): ${await res.text()}`);
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
      sendNow={sendNow}
    />
  );
}
