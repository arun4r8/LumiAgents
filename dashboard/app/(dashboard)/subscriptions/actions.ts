"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { fetchRuntime } from "@/lib/runtime-fetch";

// Shared, kind-aware subscription actions. Used by the Settings → Subscriptions tab
// (this folder keeps only the actions now that /subscriptions 308s into Settings)
// and by the contextual award-digest section on the BD Pipeline Opportunities tab.
// Every write goes to the unified orchestration.subscriptions table; `kind` comes
// from the form.


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

// Award eligibility-profile parsing. Checkbox groups → validated string[] (null when
// none picked); number fields → integer or null (empty = don't filter on it).
const VALID_HELD_SET_ASIDES = ["8(a)", "SDVOSB", "WOSB", "HUBZone"] as const;
const VALID_OWNERSHIP = ["veteran", "woman", "minority"] as const;

function parseCheckboxes(formData: FormData, field: string, valid: readonly string[]): string[] | null {
  const picked = formData.getAll(field).map(String).filter((s) => valid.includes(s));
  return picked.length > 0 ? picked : null;
}

function parseIntField(raw: FormDataEntryValue | null): number | null {
  const str = String(raw ?? "").trim();
  if (str === "") return null;
  const n = Math.round(Number(str));
  return Number.isFinite(n) ? n : null;
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

function kindFilters(kind: "opportunity" | "award", formData: FormData): Record<string, string[] | number | null> {
  return kind === "award"
    ? {
        award_types: parseList(formData.get("award_types")),
        sources: null,
        agencies: null,
        set_asides: null,
        // award eligibility profile
        held_set_asides: parseCheckboxes(formData, "held_set_asides", VALID_HELD_SET_ASIDES),
        ownership: parseCheckboxes(formData, "ownership", VALID_OWNERSHIP),
        annual_revenue_usd: parseIntField(formData.get("annual_revenue_usd")),
        founded_year: parseIntField(formData.get("founded_year")),
        headcount: parseIntField(formData.get("headcount")),
      }
    : {
        award_types: null,
        sources: parseSources(formData),
        agencies: parseList(formData.get("agencies")),
        set_asides: parseList(formData.get("set_asides")),
        // clear any award eligibility profile on an opportunity sub
        held_set_asides: null,
        ownership: null,
        annual_revenue_usd: null,
        founded_year: null,
        headcount: null,
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
  revalidatePath("/settings");
  revalidatePath("/records/bd");
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
  revalidatePath("/settings");
  revalidatePath("/records/bd");
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
  revalidatePath("/settings");
  revalidatePath("/records/bd");
}

export async function deleteSubscription(formData: FormData) {
  const supabase = await createClient();
  const id = formData.get("id") as string;
  const { error } = await supabase.schema("orchestration").from("subscriptions").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
  revalidatePath("/records/bd");
}

// Send this subscription's digest now, routing to the orchestration for its kind.
export async function sendNow(formData: FormData) {
  const id = formData.get("id") as string;
  const kind = normalizeKind(formData.get("kind"));
  const orch = REPORT_ORCH[kind];
  const token = await getToken();
  const res = await fetchRuntime(`/api/orchestrations/${encodeURIComponent(orch)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ subscriptionId: id }),
  });
  if (!res.ok) throw new Error(`Send failed (${res.status}): ${await res.text()}`);
  revalidatePath("/settings");
  revalidatePath("/records/bd");
}
