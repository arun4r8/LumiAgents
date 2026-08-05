"use client";

import Link from "next/link";
import { RunTimeline } from "@/components/run-timeline";
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
 * Run detail — the redesign's timeline screen.
 *
 * Handoff README, "Run detail": breadcrumb → mono h1 24px + dimmed version;
 * a meta row of status dot+word, agent/trigger, start time and mono elapsed;
 * then the timeline at max 920px.
 *
 * Live state comes from the same `useRunLive` poll the chat run card uses, seeded
 * with the server render so the first paint is complete and the page never flashes
 * empty. Both surfaces therefore agree by construction: one snapshot shape, one
 * derivation, one live mechanism.
 *
 * What changed for errors: this screen used to `<pre>` the raw `run.error` jsonb at
 * whoever opened it. It now shows one plain sentence plus the run id, and the raw
 * material — error text, prompts, payloads, tool calls — sits behind an ops-only
 * "Show technical detail" disclosure. `tech` is built by the server page for ops
 * users only, so a non-ops reader is never sent it.
 *
 * Not built here: the design's "Re-run" and "Cancel" buttons. There is no
 * corresponding action in the codebase yet, and a button that does nothing is
 * worse than no button — see the PR description.
 */

// ─── Ops-only technical payloads (pre-serialised on the server) ──────────────

export interface StepToolCall {
  id: string;
  name: string;
  status: string;
  statusCode: number | null;
  latencyMs: number | null;
  request: string | null;
  response: string | null;
}

export interface StepTech {
  stepId: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  prompt: string | null;
  response: string | null;
  input: string | null;
  output: string | null;
  toolCalls: StepToolCall[];
}

export interface RunDetailProps {
  snapshot: RunSnapshot;
  /** Ops only; null (not empty) for everyone else. */
  tech: StepTech[] | null;
  /** A plain-language result line pulled from the run output, when it has one. */
  resultNote: string | null;
  /** Raw run output, pre-serialised. Ops only. */
  outputDetail: string | null;
}

function hasTech(t: StepTech): boolean {
  return Boolean(
    t.model || t.prompt || t.response || t.input || t.output || t.toolCalls.length > 0,
  );
}

function TechBlock({ tech }: { tech: StepTech }) {
  return (
    <details className="tech-detail">
      <summary>Show technical detail</summary>
      <div>
        {tech.model && (
          <>
            <span className="tech-lbl">Model</span>
            <pre>
              {tech.model}
              {tech.inputTokens != null || tech.outputTokens != null
                ? `  ·  ${tech.inputTokens ?? 0} in / ${tech.outputTokens ?? 0} out tokens`
                : ""}
            </pre>
          </>
        )}
        {tech.prompt && (<><span className="tech-lbl">Prompt</span><pre>{tech.prompt}</pre></>)}
        {tech.response && (<><span className="tech-lbl">Response</span><pre>{tech.response}</pre></>)}
        {tech.input && (<><span className="tech-lbl">Input</span><pre>{tech.input}</pre></>)}
        {tech.output && (<><span className="tech-lbl">Output</span><pre>{tech.output}</pre></>)}
        {tech.toolCalls.length > 0 && (
          <>
            <span className="tech-lbl">Tool calls ({tech.toolCalls.length})</span>
            {tech.toolCalls.map((tc) => (
              <div key={tc.id}>
                <div className="tech-tool">
                  {tc.name}{" "}
                  <span className="dim">
                    {tc.status}
                    {tc.statusCode != null ? ` · ${tc.statusCode}` : ""}
                    {tc.latencyMs != null ? ` · ${tc.latencyMs}ms` : ""}
                  </span>
                </div>
                {tc.request && <pre>{tc.request}</pre>}
                {tc.response && <pre>{tc.response}</pre>}
              </div>
            ))}
          </>
        )}
      </div>
    </details>
  );
}

// ─── Meta row helpers ────────────────────────────────────────────────────────

/** Orchestration names are `<agent>/<name>`; the prefix is the owning agent. */
function agentOf(orchestration: string | null): string | null {
  if (!orchestration) return null;
  const slash = orchestration.indexOf("/");
  return slash > 0 ? orchestration.slice(0, slash) : null;
}

function bareName(orchestration: string | null): string {
  if (!orchestration) return "run";
  const slash = orchestration.indexOf("/");
  return slash > 0 ? orchestration.slice(slash + 1) : orchestration;
}

function fmtClock(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusWordOf(status: string): string {
  return status === "pending" ? "queued" : status;
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export function RunDetailClient({ snapshot: seed, tech, resultNote, outputDetail }: RunDetailProps) {
  const { snapshot } = useRunLive(seed.runId, seed);
  const run = snapshot ?? seed;

  const settled = isTerminal(run.status);
  const now = useNow(!settled);
  const elapsed = fmtElapsed(elapsedMs(run, now));

  const techById = new Map((tech ?? []).map((t) => [t.stepId, t]));
  const renderTech = tech
    ? (step: RunStepView) => {
        const t = techById.get(step.id);
        return t && hasTech(t) ? <TechBlock tech={t} /> : null;
      }
    : undefined;

  const agent = agentOf(run.orchestration);
  const started = fmtClock(run.startedAt ?? run.createdAt);
  const statusWord = statusWordOf(run.status);

  return (
    <div className="page">
      <div className="rd-crumb">
        <Link href="/runs">Runs</Link>
        <span className="sep">/</span>
        <span className="id" title={run.runId}>{shortRunId(run.runId)}</span>
      </div>

      <div className="rd-head">
        <h1 className="rd-title">
          {bareName(run.orchestration)}
          {run.version != null && <span className="v"> v{run.version}</span>}
        </h1>
      </div>

      <div className="rd-meta">
        <span className={`rd-status is-${run.status}`}>
          <span className="run-dot" aria-hidden="true" />
          {statusWord}
        </span>
        <span>
          {agent ? `${agent} · ` : ""}
          triggered by {run.triggeredBy ?? "unknown"}
        </span>
        {started && <span>started {started}</span>}
        <span className="rd-elapsed">elapsed {elapsed}</span>
        <span className="rd-elapsed">
          {run.doneCount}/{run.total || run.steps.length} steps
        </span>
      </div>

      <RunTimeline snapshot={run} techDetail={renderTech} />

      {run.status === "failed" && run.errorSummary && (
        <div style={{ maxWidth: 920 }}>
          <RunErrorNote
            summary={run.errorSummary}
            detail={run.errorDetail}
            runId={run.runId}
          />
        </div>
      )}

      {run.status === "completed" && (resultNote || outputDetail) && (
        <div className="rd-result">
          <span className="rd-section-label">Result</span>
          {resultNote && <div className="rt-card">{resultNote}</div>}
          {outputDetail && (
            <details className="tech-detail">
              <summary>Show technical detail</summary>
              <span className="tech-lbl">Run output</span>
              <pre>{outputDetail}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default RunDetailClient;
