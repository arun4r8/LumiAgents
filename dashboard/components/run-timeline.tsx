"use client";

import { RunErrorNote } from "@/components/run-error-note";
import type { RunSnapshot, RunStepView } from "@/lib/run-view";

/**
 * The run-detail timeline — the run card's expanded form.
 *
 * Handoff README, "Run detail": max 920px; 18px nodes on a 1px rail that fades
 * `linear-gradient(--color-neutral-700, --color-neutral-800)` and goes transparent
 * after the running step; 32px gutter, 18px gap; per step a mono 13.5px name plus
 * an 11.5px meta, then a tonal body card (bg --color-neutral-800, radius 8px,
 * 12px 16px, 12.5px/1.6). The running LLM step's card takes a 1px
 * --color-accent-800 border and a labelled 3px progress bar. Queued steps sit at
 * 50% opacity with no body.
 *
 * All of that lives in the `.rt-*` block of app/lumi.css. The component's only job
 * is deciding which state each row is in and where the rail stops.
 *
 * `techDetail` is the ops-only escape hatch: raw material (prompts, payloads, tool
 * calls) for a given step id. It is supplied by the server page for ops users only
 * and is absent entirely for everyone else.
 */

export interface TimelineProps {
  snapshot: RunSnapshot;
  /** Rendered inside a per-step "Show technical detail" disclosure. Ops only. */
  techDetail?: (step: RunStepView) => React.ReactNode;
}

function StepBody({
  step,
  progressPct,
  tech,
}: {
  step: RunStepView;
  progressPct: number;
  tech?: React.ReactNode;
}) {
  // Queued steps have no body at all — the design is explicit about this.
  if (step.state === "queued") return null;

  // A failed step still renders {tech}. It used to return here without it, which
  // dropped the model, prompt, response, step input and tool calls for exactly the
  // step someone opened the run to diagnose -- the data was fetched, computed and
  // passed in, then discarded on this branch alone. `tech` is already ops-gated by
  // the caller, so this exposes nothing new.
  if (step.errorSummary) {
    return (
      <>
        <RunErrorNote
          className="rt-card is-error"
          label="Step failed"
          summary={step.errorSummary}
          detail={step.errorDetail}
        />
        {tech}
      </>
    );
  }

  // The running LLM step: a bordered card with a labelled progress bar.
  if (step.progressLabel) {
    return (
      <div className="rt-card is-active">
        <div className="rt-prog-head">
          <span>{step.progressLabel}</span>
          <span className="rt-prog-pct">{progressPct}%</span>
        </div>
        <div className="rt-prog">
          <i style={{ width: `${progressPct}%` }} />
        </div>
        {tech}
      </div>
    );
  }

  if (!step.body && !tech) return null;

  return (
    <div className="rt-card">
      {step.body}
      {tech}
    </div>
  );
}

export function RunTimeline({ snapshot, techDetail }: TimelineProps) {
  const steps = snapshot.steps;

  // The rail is drawn only as far as the run has got: the connector leaving the
  // running step, and every connector after it, is transparent.
  const runningAt = steps.findIndex((s) => s.state === "running");

  if (steps.length === 0) {
    return (
      <div className="rt">
        <div className="run-card-empty" style={{ padding: "20px 0" }}>
          {snapshot.status === "pending" || snapshot.status === "running"
            ? "waiting for the first step…"
            : "no steps recorded"}
        </div>
      </div>
    );
  }

  return (
    <div className="rt">
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        const future = runningAt >= 0 && i >= runningAt;
        const tech = techDetail?.(step);
        return (
          <div key={step.id} className={`rt-step is-${step.state}`}>
            <div className="rt-rail">
              <span className={`rt-node is-${step.state}`} aria-hidden="true" />
              {!isLast && <span className={`rt-line${future ? " is-future" : ""}`} />}
            </div>
            <div className="rt-body">
              <div className="rt-head">
                <span className="rt-name">{step.name}</span>
                <span className="rt-meta">{step.meta}</span>
              </div>
              <StepBody step={step} progressPct={snapshot.progressPct} tech={tech} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default RunTimeline;
