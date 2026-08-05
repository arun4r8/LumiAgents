import { createClient } from "@/lib/supabase/server";
import { DataClient } from "@/components/data-client";
import { insertRow, bulkInsert, deleteRow } from "./actions";

export const dynamic = "force-dynamic";

export default async function DataPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const initialTab = tab === "ask" ? "ask" : undefined;
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
    staffRequestsRes,
    resumeJobsRes,
    resumeResultsRes,
  ] = await Promise.all([
    supabase.from("contracts").select("*").order("created_at", { ascending: false }).limit(100),
    supabase.from("invoices").select("*").order("invoice_date", { ascending: false }).limit(100),
    supabase.from("budget_lines").select("*").order("created_at", { ascending: false }).limit(100),
    supabase.from("labor_records").select("*").order("work_date", { ascending: false }).limit(100),
    supabase.from("indirect_rates").select("*").order("fiscal_year", { ascending: false }).limit(50),
    supabase.from("employees").select("*").order("full_name").limit(200),
    supabase.from("past_performance").select("*").order("created_at", { ascending: false }).limit(100),
    supabase.from("opportunities")
      .select("id, title, agency, set_aside, recommendation, fit_score, fit_reason, red_flags, last_scored_at, response_deadline, status, solicitation_number, naics_code, created_at")
      .order("created_at", { ascending: false }).limit(100),
    supabase.from("candidates")
      .select("id, name, email, first_name, last_name, role, status, current_title, current_company, match_score, match_reason, seniority, linkedin_url, source, outreach_sent, created_at")
      .order("created_at", { ascending: false }).limit(100),
    supabase.from("staff_requests")
      .select("id, title, request_type, urgency, status, requested_by, jira_key, contract_id, created_at")
      .order("created_at", { ascending: false }).limit(100),
    supabase.from("resume_jobs")
      .select("id, job, status, total, processed, created_at")
      .order("created_at", { ascending: false }).limit(50),
    supabase.from("resume_results")
      .select("id, job_id, status, name, email, mobile_number, location, school, field_of_study, gpa, grad_year, role, technical_skills_score, work_experience_score, academics_score, projects_and_research_score, leadership_and_initiative_score, overall_score, rationale, error, created_at")
      .order("overall_score", { ascending: false }).limit(2000),
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
      staffRequests={(staffRequestsRes.data ?? []) as Record<string, unknown>[]}
      resumeJobs={(resumeJobsRes.data ?? []) as Record<string, unknown>[]}
      resumeResults={(resumeResultsRes.data ?? []) as Record<string, unknown>[]}
      insertRow={insertRow}
      bulkInsert={bulkInsert}
      deleteRow={deleteRow}
      initialTab={initialTab}
    />
  );
}
