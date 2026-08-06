"use client";

import Link from "next/link";
import { RunErrorNote } from "@/components/run-error-note";
import { useNow, useRunLive } from "@/lib/use-run-live";
import {
  elapsedMs,
  fmtElapsed,
  isTerminal,
  shortRunId,
  type RunSnapshot,
  type RunStepView,
} from "@/lib/run-view";

/**
 * The embedded run card — the redesign's signature component.
 *
 * Built once, mounted twice: inline in the agent chat transcript (replacing the
 * static "View run →" chip) and at the head of the run-detail page. The card owns
 * nothing but presentation; live state comes from `useRunLive`, which polls the
 * RLS-scoped /api/runs/:id endpoint and stops the moment the run settles.
 *
 * Geometry is the handoff README's: bordered --color-neutral-700, radius 10px,
 * bg --color-neutral-800; a header of 7px status dot + mono orchestration name +
 * mono dimmed run id + right-aligned "step/total · elapsed"; 14px step nodes;
 * a 3px accent progress bar in the footer. See the `.run-card*` block in
 * app/lumi.css — the only inline style here is the bar's width, which has to be
 * a number.
 */

// ─── Presentational card ─────────────────────────────────────────────────────

function dotClass(status: string): string {
  switch (status) {
    case "running":   return "run-dot is-running";
    case "completed": return "run-dot is-completed";
    case "failed":    return "run-dot is-failed";
    case "paused":    return "run-dot is-paused";
    default:          return "run-dot";
  }
}

function StepRow({ step }: { step: RunStepView }) {
  return (
    <div className={`run-step is-${step.state}`}>
      <span className={`run-node is-${step.state}`} aria-hidden="true" />
      <span className="run-step-name" title={step.name}>{step.name}</span>
      <span className="run-step-meta">{step.meta}</span>
    </div>
  );
}

export function RunCardView({
  snapshot,
  /** Used when RLS hides the joined orchestration row (see lib/run-snapshot.ts). */
  fallbackName,
  linkToDetail = true,
}: {
  snapshot: RunSnapshot;
  fallbackName?: string;
  linkToDetail?: boolean;
}) {
  const inFlight = !isTerminal(snapshot.status);
  const now = useNow(inFlight);
  const elapsed = fmtElapsed(elapsedMs(snapshot, now));

  const name = snapshot.orchestration ?? fallbackName ?? "orchestration";
  const stepCount = snapshot.total > 0 ? `${snapshot.doneCount}/${snapshot.total}` : "-";
  const idLabel = shortRunId(snapshot.runId);

  const statusWord =
    snapshot.status === "pending" ? "queued" : snapshot.status;

  return (
    <div className="run-card">
      <div className="run-card-head">
        <span
          className={dotClass(snapshot.status)}
          role="img"
          aria-label={`Run ${statusWord}`}
        />
        <span className="run-card-name">{name}</span>
        {linkToDetail ? (
          <Link className="run-card-id" href={`/runs/${snapshot.runId}`} title={snapshot.runId}>
            {idLabel}
          </Link>
        ) : (
          <span className="run-card-id" title={snapshot.runId}>{idLabel}</span>
        )}
        <span className="run-card-meta">
          {stepCount} · {elapsed}
        </span>
      </div>

      {snapshot.steps.length === 0 ? (
        <div className="run-card-empty">
          {inFlight ? "waiting for the first step…" : `run ${statusWord}, no steps recorded`}
        </div>
      ) : (
        <div className="run-card-steps">
          {snapshot.steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </div>
      )}

      {snapshot.status === "failed" && snapshot.errorSummary && (
        <RunErrorNote
          summary={snapshot.errorSummary}
          detail={snapshot.errorDetail}
          runId={snapshot.runId}
        />
      )}

      <div className="run-card-bar">
        <i style={{ width: `${snapshot.progressPct}%` }} />
      </div>
    </div>
  );
}

// ─── Live card ───────────────────────────────────────────────────────────────

/**
 * The card as used in chat: given a run id (and the orchestration name the chat
 * response already carried), it fetches and then follows the run to completion.
 */
export function RunCard({
  runId,
  orchestration,
  initial,
}: {
  runId: string;
  orchestration?: string;
  initial?: RunSnapshot | null;
}) {
  const { snapshot, visible, loading } = useRunLive(runId, initial);

  // Not readable under RLS — an ops run an enduser did not start, or a deleted
  // run. Say so plainly instead of surfacing a 404 or an empty card.
  if (!visible) {
    return (
      <div className="run-card">
        <div className="run-card-head">
          <span className="run-dot" aria-hidden="true" />
          <span className="run-card-name">{orchestration ?? "run"}</span>
          <span className="run-card-id">{shortRunId(runId)}</span>
        </div>
        <div className="run-card-empty">this run isn&apos;t available to you</div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="run-card">
        <div className="run-card-head">
          <span className="run-dot" aria-hidden="true" />
          <span className="run-card-name">{orchestration ?? "run"}</span>
          <span className="run-card-id">{shortRunId(runId)}</span>
        </div>
        <div className="run-card-empty">{loading ? "loading…" : "no run data"}</div>
      </div>
    );
  }

  return <RunCardView snapshot={snapshot} fallbackName={orchestration} />;
}

export default RunCard;
