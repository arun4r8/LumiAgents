import { createClient } from "@/lib/supabase/server";
import { RunsClient } from "@/components/runs-client";

export const dynamic = "force-dynamic";

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ orchestration?: string }>;
}) {
  const { orchestration } = await searchParams;
  const supabase = await createClient();

  const { data: runs } = await supabase
    .schema("orchestration")
    .from("runs")
    .select("id, status, triggered_by, created_at, started_at, ended_at, orchestrations(name, version)")
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <RunsClient
      runs={(runs ?? []) as unknown as Parameters<typeof RunsClient>[0]["runs"]}
      initialFilter={orchestration}
    />
  );
}
