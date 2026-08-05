import { createClient } from "@/lib/supabase/server";
import { TalentClient } from "@/components/talent-client";

export const dynamic = "force-dynamic";

/**
 * Talent — a RECORDS domain the old flat nav never had a screen for. The data
 * already exists (candidates + resume_jobs/resume_results + staff_requests were
 * buried in the Records page's "People" tab), so this route surfaces those same
 * tables directly rather than inventing anything: the panels are the exact
 * components the Data screen renders. When the tables are empty the page says
 * so — no placeholder rows.
 */

export default async function TalentPage() {
  const supabase = await createClient();

  const [candidatesRes, staffRequestsRes, resumeJobsRes, resumeResultsRes] = await Promise.all([
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
    <TalentClient
      candidates={(candidatesRes.data ?? []) as Record<string, unknown>[]}
      staffRequests={(staffRequestsRes.data ?? []) as Record<string, unknown>[]}
      resumeJobs={(resumeJobsRes.data ?? []) as Record<string, unknown>[]}
      resumeResults={(resumeResultsRes.data ?? []) as Record<string, unknown>[]}
    />
  );
}
