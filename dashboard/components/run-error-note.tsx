"use client";

import { shortRunId } from "@/lib/run-view";

/**
 * How a failure is surfaced to a person.
 *
 * Before phase 3 both run surfaces printed the raw `jsonb` error at whoever was
 * looking (`JSON.stringify(step.error)` in steps-timeline, raw `run.error` in
 * run-detail). That is unreadable for an enduser and leaks internals.
 *
 * Now: one plain sentence plus the run id — enough to describe the problem and to
 * quote when asking for help — with the raw text tucked behind an ops-only
 * disclosure. `detail` is null for non-ops callers because the API strips it
 * server-side (see lib/run-view.ts `snapshotFor`), so this component cannot leak
 * it even if it were rendered by mistake.
 */
export function RunErrorNote({
  summary,
  detail,
  runId,
  label = "Run failed",
  className = "run-note",
}: {
  summary: string;
  detail?: string | null;
  /** Shown so the reader can quote it. Omit inside a step, where it is redundant. */
  runId?: string;
  label?: string;
  /** "run-note" as a card footer; "rt-card is-error" as a timeline body card. */
  className?: string;
}) {
  return (
    <div className={className}>
      <span className="run-note-label">{label}</span>
      <p className="run-note-text">{summary}</p>
      {runId && <span className="run-note-id">{shortRunId(runId)} · {runId}</span>}
      {detail && (
        <details className="tech-detail">
          <summary>Show technical detail</summary>
          <pre>{detail}</pre>
        </details>
      )}
    </div>
  );
}

export default RunErrorNote;
