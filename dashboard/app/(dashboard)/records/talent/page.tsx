import { createClient } from "@/lib/supabase/server";
import { errorSummary, isTerminal } from "@/lib/run-view";
import { TalentClient } from "@/components/talent-client";

export const dynamic = "force-dynamic";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

const REDACT_ORCHESTRATION = "angie/resume-redact";

// Guard before the query: a non-uuid would make PostgREST raise 22P02 rather
// than simply return nothing. Same guard lib/run-snapshot.ts applies.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `angie/resume-redact` output contract, once it has been checked. */
export interface RedactionOutput {
  redacted_resume: string;
  removed: string[];
  verified_clean: boolean;
  residual_findings: string[];
}

/** What one poll of a redaction run tells the panel. */
export interface RedactionState {
  /** orchestration.run_status, or "missing" when the row is not visible yet. */
  status: string;
  /** True once there is nothing left to wait for. Stop polling. */
  done: boolean;
  /** Present only on a completed run whose output parsed. */
  output: RedactionOutput | null;
  /** One plain sentence. Set whenever `done` is true without an output. */
  error: string | null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/**
 * Coerce the run's jsonb output into the shape the panel renders.
 *
 * `verified_clean` is compared against `true` rather than coerced, so a missing,
 * null or otherwise unexpected value reads as NOT verified. The whole point of
 * this screen is that a leaky document cannot be downloaded unremarked, and
 * failing open here would quietly defeat that.
 */
function toRedactionOutput(value: unknown): RedactionOutput | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.redacted_resume !== "string" || o.redacted_resume.length === 0) return null;
  return {
    redacted_resume: o.redacted_resume,
    removed: stringList(o.removed),
    verified_clean: o.verified_clean === true,
    residual_findings: stringList(o.residual_findings),
  };
}

async function getToken(): Promise<string> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("No active session");
  return session.access_token;
}

/**
 * Talent. A RECORDS domain the old flat nav never had a screen for. The data
 * already exists (candidates + resume_jobs/resume_results + staff_requests were
 * buried in the Records page's "People" tab), so this route surfaces those same
 * tables directly rather than inventing anything: the panels are the exact
 * components the Data screen renders. When the tables are empty the page says
 * so, with no placeholder rows.
 *
 * Blind resume export (#156) sits above them, because preparing a client-safe
 * copy of a resume is a thing you do to a candidate rather than a report on one.
 */
export default async function TalentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // ?run=<id> arrives from the Teams bot's deep link: the run already started
  // over there, so the panel resumes it rather than asking for the text again.
  const sp = await searchParams;
  const runParam = typeof sp.run === "string" ? sp.run : undefined;
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

  // Fires angie/resume-redact on the durable /run path (the same path
  // draftWithCleo uses on the Content screen) and hands the run id back so the
  // panel can follow it. That endpoint answers 202 with { runId, status }.
  async function startRedaction(resumeText: string, candidateCode: string): Promise<string> {
    "use server";
    const text = resumeText.trim();
    if (!text) throw new Error("Paste the resume text before running the redaction.");
    const code = candidateCode.trim();

    const token = await getToken();
    const res = await fetch(
      `${RUNTIME}/api/orchestrations/${encodeURIComponent(REDACT_ORCHESTRATION)}/run`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          resume_text: text,
          candidate_code: code.length > 0 ? code : undefined,
        }),
      },
    );
    if (!res.ok) throw new Error(`Redaction failed to start (${res.status}): ${await res.text()}`);

    const body = (await res.json()) as { runId?: unknown };
    if (typeof body.runId !== "string" || body.runId.length === 0) {
      throw new Error("The runtime accepted the redaction but returned no run id.");
    }
    return body.runId;
  }

  /**
   * One poll of a redaction run.
   *
   * Reads orchestration.runs directly rather than going through
   * lib/run-snapshot.ts, which never selects the `output` column (it renders a
   * step timeline, not a result) and so cannot answer the only question this
   * panel has. Same RLS-scoped client either way: the user sees their own runs
   * through the anon key and their cookie session, never the service role.
   */
  async function getRedactionResult(runId: string): Promise<RedactionState> {
    "use server";
    if (!UUID_RE.test(runId)) {
      return { status: "missing", done: true, output: null, error: "That is not a valid run id." };
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .schema("orchestration")
      .from("runs")
      .select("status, output, error")
      .eq("id", runId)
      .maybeSingle();

    if (error) {
      return { status: "missing", done: true, output: null, error: "Could not read the redaction run." };
    }
    if (!data) {
      // Not visible yet (or not ours). Keep waiting rather than calling it a
      // failure; the panel gives up on its own after a bounded number of polls.
      return { status: "missing", done: false, output: null, error: null };
    }

    const row = data as unknown as { status: string; output: unknown; error: unknown };

    if (row.status === "paused") {
      return {
        status: row.status,
        done: true,
        output: null,
        error: "The redaction run is paused awaiting an approval, so there is no document yet.",
      };
    }
    if (!isTerminal(row.status)) {
      return { status: row.status, done: false, output: null, error: null };
    }
    if (row.status !== "completed") {
      return {
        status: row.status,
        done: true,
        output: null,
        error: errorSummary(row.error) ?? `The redaction run ${row.status}.`,
      };
    }

    const output = toRedactionOutput(row.output);
    return {
      status: row.status,
      done: true,
      output,
      error: output ? null : "The run finished but produced no redacted resume.",
    };
  }

  return (
    <TalentClient
      initialRunId={runParam}
      candidates={(candidatesRes.data ?? []) as Record<string, unknown>[]}
      staffRequests={(staffRequestsRes.data ?? []) as Record<string, unknown>[]}
      resumeJobs={(resumeJobsRes.data ?? []) as Record<string, unknown>[]}
      resumeResults={(resumeResultsRes.data ?? []) as Record<string, unknown>[]}
      startRedaction={startRedaction}
      getRedactionResult={getRedactionResult}
    />
  );
}
