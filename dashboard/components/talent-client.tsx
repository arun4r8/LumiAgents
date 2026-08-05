"use client";

import { CandidatesPanel, ResumeResultsPanel, StaffRequestsPanel } from "./data-client";

interface Props {
  candidates: Record<string, unknown>[];
  staffRequests: Record<string, unknown>[];
  resumeJobs: Record<string, unknown>[];
  resumeResults: Record<string, unknown>[];
}

/**
 * Talent screen. Composes the three people-shaped panels the Records screen
 * already renders — no new table code, no sample rows. If every table is empty
 * the page says exactly that and names the orchestrations that fill them.
 */
export function TalentClient({ candidates, staffRequests, resumeJobs, resumeResults }: Props) {
  const empty =
    candidates.length === 0 &&
    staffRequests.length === 0 &&
    resumeJobs.length === 0 &&
    resumeResults.length === 0;

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Talent</h1>
          <div className="sub">Candidates, resume scoring, and staffing requests.</div>
        </div>
      </div>

      {empty ? (
        <div className="empty-state">
          <div className="empty-title">Nothing here yet</div>
          <p className="empty-body">
            No candidates, resume batches, or staff requests have been recorded. These tables
            fill up when <code className="mono">angie/resume-scoring</code> scores a batch or{" "}
            <code className="mono">patch/staff-request</code> opens a request.
          </p>
        </div>
      ) : (
        <>
          <ResumeResultsPanel resumeJobs={resumeJobs} resumeResults={resumeResults} />
          <CandidatesPanel candidates={candidates} />
          <StaffRequestsPanel staffRequests={staffRequests} />
        </>
      )}
    </div>
  );
}

export default TalentClient;
