"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

// Shared, kind-aware subscription actions. Used by the aggregate /subscriptions page
// and by the contextual award-digest section on /awards. Every write goes to the
// unified orchestration.subscriptions table; `kind` comes from the form.

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

// kind → which orchestration sends its digest on the manual "Send now" path.
const REPORT_ORCH: Record<string, string> = {
  opportunity: "beady/opportunity-report",
  award: "cleo/award-report",
};

function parseRecipients(raw: string): string[] {
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
}

function parseList(raw: FormDataEntryValue | null): string[] | null {
  const items = String(raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return items.length > 0 ? items : null;
}

const VALID_SOURCES = ["sam_gov", "sbir"] as const;
function parseSources(formData: FormData): string[] | null {
  const picked = formData.getAll("sources").map(String).filter((s) => (VALID_SOURCES as readonly string[]).includes(s));
  return picked.length > 0 ? picked : null;
}

function clampScore(raw: FormDataEntryValue | null, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(10, Math.max(1, n));
}

function normalizeKind(raw: FormDataEntryValue | null): "opportunity" | "award" {
  return raw === "award" ? "award" : "opportunity";
}

async function getToken(): Promise<string> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("No active session");
  return session.access_token;
}

function kindFilters(kind: "opportunity" | "award", formData: FormData): Record<string, string[] | null> {
  return kind === "award"
    ? { award_types: parseList(formData.get("award_types")), sources: null, agencies: null, set_asides: null }
    : {
        award_types: null,
        sources: parseSources(formData),
        agencies: parseList(formData.get("agencies")),
        set_asides: parseList(formData.get("set_asides")),
      };
}

export async function createSubscription(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const recipients = parseRecipients((formData.get("recipients") as string) ?? "");
  if (recipients.length === 0) throw new Error("At least one recipient email is required.");
  const kind = normalizeKind(formData.get("kind"));
  const cadence = formData.get("cadence") === "daily" ? "daily" : "weekly";
  const { error } = await supabase
    .schema("orchestration")
    .from("subscriptions")
    .insert({
      user_id: user?.id ?? null,
      kind,
      label: (formData.get("label") as string)?.trim() || null,
      cadence,
      recipients,
      min_fit_score: clampScore(formData.get("min_fit_score"), kind === "award" ? 6 : 7),
      ...kindFilters(kind, formData),
      is_active: true,
    });
  if (error) throw new Error(error.message);
  revalidatePath("/subscriptions");
  revalidatePath("/awards");
}

export async function updateSubscription(formData: FormData) {
  const supabase = await createClient();
  const id = formData.get("id") as string;
  const recipients = parseRecipients((formData.get("recipients") as string) ?? "");
  if (recipients.length === 0) throw new Error("At least one recipient email is required.");
  const kind = normalizeKind(formData.get("kind"));
  const cadence = formData.get("cadence") === "daily" ? "daily" : "weekly";
  const { error } = await supabase
    .schema("orchestration")
    .from("subscriptions")
    .update({
      label: (formData.get("label") as string)?.trim() || null,
      cadence,
      recipients,
      min_fit_score: clampScore(formData.get("min_fit_score"), kind === "award" ? 6 : 7),
      ...kindFilters(kind, formData),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/subscriptions");
  revalidatePath("/awards");
}

export async function toggleSubscription(formData: FormData) {
  const supabase = await createClient();
  const id = formData.get("id") as string;
  const currentlyActive = formData.get("is_active") === "true";
  const { error } = await supabase
    .schema("orchestration")
    .from("subscriptions")
    .update({ is_active: !currentlyActive, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/subscriptions");
  revalidatePath("/awards");
}

export async function deleteSubscription(formData: FormData) {
  const supabase = await createClient();
  const id = formData.get("id") as string;
  const { error } = await supabase.schema("orchestration").from("subscriptions").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/subscriptions");
  revalidatePath("/awards");
}

// Send this subscription's digest now, routing to the orchestration for its kind.
export async function sendNow(formData: FormData) {
  const id = formData.get("id") as string;
  const kind = normalizeKind(formData.get("kind"));
  const orch = REPORT_ORCH[kind];
  const token = await getToken();
  const res = await fetch(`${RUNTIME}/api/orchestrations/${encodeURIComponent(orch)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ subscriptionId: id }),
  });
  if (!res.ok) throw new Error(`Send failed (${res.status}): ${await res.text()}`);
  revalidatePath("/subscriptions");
  revalidatePath("/awards");
}
