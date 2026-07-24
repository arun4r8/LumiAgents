import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { OrchestrationsClient } from "@/components/orchestrations-client";

export const dynamic = "force-dynamic";

// Orchestrations that have a dedicated dashboard surface and shouldn't also appear
// in the raw catalogue. beady/opportunity-report is managed entirely from the
// Subscriptions page (subscriptions + "Send now"); triggering it here with raw input
// would just be a confusing duplicate.
const HIDDEN_FROM_CATALOGUE = ["beady/opportunity-report"];

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

export default async function OrchestrationsPage() {
  const supabase = await createClient();

  const { data: orchestrations } = await supabase
    .schema("orchestration")
    .from("orchestrations")
    .select("id, name, version, description, is_active, cron, trigger_mode")
    .neq("trigger_mode", "webhook")
    .order("name");

  // Only show orchestrations that still exist in the code registry, so a retired
  // orchestration whose catalog row lingers (its row is kept for run-history FKs)
  // doesn't show up as a runnable card. Falls back to the full DB catalogue if the
  // runtime is unreachable, so a transient outage never blanks the page.
  let registered: Set<string> | null = null;
  try {
    const res = await fetch(`${RUNTIME}/api/orchestrations`, { cache: "no-store" });
    if (res.ok) {
      const catalogue = (await res.json()) as { name: string }[];
      registered = new Set(catalogue.map((c) => c.name));
    }
  } catch {
    // runtime unreachable — leave `registered` null and show the DB catalogue as-is
  }

  const orcList = ((orchestrations ?? []) as {
    id: string;
    name: string;
    version: string | number;
    description: string | null;
    is_active: boolean;
    cron: string | null;
    trigger_mode: string;
  }[]).filter(
    (o) =>
      !HIDDEN_FROM_CATALOGUE.includes(o.name) &&
      (registered === null || registered.has(o.name)),
  );

  async function toggleOrchestration(formData: FormData) {
    "use server";
    const sb = await createClient();
    const id = formData.get("id") as string;
    const currentlyActive = formData.get("is_active") === "true";
    await sb.schema("orchestration").from("orchestrations")
      .update({ is_active: !currentlyActive })
      .eq("id", id);
    revalidatePath("/orchestrations");
  }

  return <OrchestrationsClient orchestrations={orcList} toggleOrchestration={toggleOrchestration} />;
}
