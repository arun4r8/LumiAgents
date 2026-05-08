import { createClient } from "@/lib/supabase/server";
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

  return <OrchestrationsClient orchestrations={orcList} />;
}
