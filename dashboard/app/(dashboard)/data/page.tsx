import { createClient } from "@/lib/supabase/server";
import { DataClient } from "@/components/data-client";
import { insertRow, bulkInsert, deleteRow } from "./actions";

export const dynamic = "force-dynamic";

export default async function DataPage() {
  const supabase = await createClient();

  const [
    contractsRes,
    invoicesRes,
    budgetLinesRes,
    laborRecordsRes,
    indirectRatesRes,
    employeesRes,
    pastPerfRes,
    opportunitiesRes,
    candidatesRes,
  ] = await Promise.all([
    supabase.from("contracts").select("*").order("created_at", { ascending: false }).limit(100),
    supabase.from("invoices").select("*").order("invoice_date", { ascending: false }).limit(100),
    supabase.from("budget_lines").select("*").order("created_at", { ascending: false }).limit(100),
    supabase.from("labor_records").select("*").order("work_date", { ascending: false }).limit(100),
    supabase.from("indirect_rates").select("*").order("fiscal_year", { ascending: false }).limit(50),
    supabase.from("employees").select("*").order("full_name").limit(200),
    supabase.from("past_performance").select("*").order("created_at", { ascending: false }).limit(100),
    supabase.from("opportunities").select("id, opportunity_name, agency, set_aside, recommendation, created_at").order("created_at", { ascending: false }).limit(50),
    supabase.from("candidates").select("id, name, email, role, status, created_at").order("created_at", { ascending: false }).limit(100),
  ]);

  return (
    <DataClient
      contracts={(contractsRes.data ?? []) as Record<string, unknown>[]}
      invoices={(invoicesRes.data ?? []) as Record<string, unknown>[]}
      budgetLines={(budgetLinesRes.data ?? []) as Record<string, unknown>[]}
      laborRecords={(laborRecordsRes.data ?? []) as Record<string, unknown>[]}
      indirectRates={(indirectRatesRes.data ?? []) as Record<string, unknown>[]}
      employees={(employeesRes.data ?? []) as Record<string, unknown>[]}
      pastPerformance={(pastPerfRes.data ?? []) as Record<string, unknown>[]}
      opportunities={(opportunitiesRes.data ?? []) as Record<string, unknown>[]}
      candidates={(candidatesRes.data ?? []) as Record<string, unknown>[]}
      insertRow={insertRow}
      bulkInsert={bulkInsert}
      deleteRow={deleteRow}
    />
  );
}
