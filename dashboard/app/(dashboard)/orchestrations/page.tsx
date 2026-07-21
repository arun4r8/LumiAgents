import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { OrchestrationsClient } from "@/components/orchestrations-client";

export const dynamic = "force-dynamic";

// Orchestrations that have a dedicated dashboard surface and shouldn't also appear
// in the raw catalogue. beady/opportunity-report is managed entirely from the
// Subscriptions page (subscriptions + "Send now"); triggering it here with raw input
// would just be a confusing duplicate.
const HIDDEN_FROM_CATALOGUE = ["beady/opportunity-report"];

export default async function OrchestrationsPage() {
  const supabase = await createClient();

  const { data: orchestrations } = await supabase
    .schema("orchestration")
    .from("orchestrations")
    .select("id, name, version, description, is_active, cron, trigger_mode")
    .neq("trigger_mode", "webhook")
    .order("name");

  const orcList = ((orchestrations ?? []) as {
    id: string;
    name: string;
    version: string | number;
    description: string | null;
    is_active: boolean;
    cron: string | null;
    trigger_mode: string;
  }[]).filter((o) => !HIDDEN_FROM_CATALOGUE.includes(o.name));

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
