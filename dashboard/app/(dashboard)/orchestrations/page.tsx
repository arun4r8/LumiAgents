import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { OrchestrationsClient } from "@/components/orchestrations-client";

export const dynamic = "force-dynamic";

export default async function OrchestrationsPage() {
  const supabase = await createClient();

  const { data: orchestrations } = await supabase
    .schema("orchestration")
    .from("orchestrations")
    .select("id, name, version, description, is_active, cron")
    .order("name");

  const orcList = (orchestrations ?? []) as {
    id: string;
    name: string;
    version: string | number;
    description: string | null;
    is_active: boolean;
    cron: string | null;
  }[];

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
