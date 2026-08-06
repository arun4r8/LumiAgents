"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RunTimeline } from "@/components/run-timeline";
import { RunErrorNote } from "@/components/run-error-note";
import { LocalTime } from "@/components/lumi";
import { runtimeAuthHeader } from "@/lib/runtime-auth";
import { useNow, useRunLive } from "@/lib/use-run-live";
import {
  elapsedMs,
  fmtElapsed,
  isTerminal,
  shortRunId,
  type RunSnapshot,
  type RunStatus,
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
 * The header's "Re-run" and "Cancel" (handoff README, "Run detail": secondary
 * Re-run + ghost Cancel) are now real: they call POST /api/runs/:id/rerun and
 * POST /api/runs/:id/cancel on the runtime Worker. Both are HIDDEN, not disabled,
 * when unavailable — see `RunActions` for the two rules and for why the cancel
 * feedback is deliberately worded as "stopping" rather than "stopped".
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

function statusWordOf(status: string): string {
  return status === "pending" ? "queued" : status;
}

// ─── Header actions: Re-run / Cancel ─────────────────────────────────────────

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "";

/** Mirrors runtime `CANCELLABLE` (routes/runs.ts): the statuses a run can be stopped from. */
const CANCELLABLE: ReadonlySet<RunStatus> = new Set<RunStatus>(["pending", "running", "paused"]);

interface Notice {
  tone: "ok" | "warn" | "err";
  title: string;
  text: string;
  /** Field paths from a 422 schema rejection. */
  issues?: string[];
}

interface CancelResult {
  status: string;
  terminated: boolean;
  message: string;
}

interface RerunResult {
  runId: string;
}

interface ErrorBody {
  error?: string;
  issues?: { path?: (string | number)[]; message?: string }[];
}

function issueLines(issues: ErrorBody["issues"]): string[] {
  return (issues ?? []).slice(0, 8).map((i) => {
    const path = (i.path ?? []).join(".") || "(root)";
    return `${path}: ${i.message ?? "invalid"}`;
  });
}

/**
 * The two buttons the redesign asks for, and the two rules that decide whether
 * they exist at all. They are hidden rather than disabled, because a disabled
 * button still advertises an action the reader will never be allowed to take.
 *
 *   Re-run — shown only when `snapshot.orchestration` is non-null. That field is
 *     the joined orchestration name read under the caller's OWN RLS session, so it
 *     is null exactly when the caller may not see the orchestration (for an
 *     enduser: it is not active). That is the same predicate the runtime applies
 *     server-side in `canRerunRun`, so the button is present precisely when the
 *     endpoint would say yes.
 *
 *   Cancel — shown only while the run is pending/running/paused, mirroring the
 *     runtime's CANCELLABLE set. Everyone who can open this page can already see
 *     the run, and seeing the run is the whole authorization rule for cancelling
 *     it, so there is no per-user gate on top.
 *
 * Cancel confirms first, inline: it stops work that is genuinely in progress, and
 * that is not something to do on a stray click.
 *
 * Honesty about the result matters more here than brevity. The runtime tells us
 * whether it actually terminated the durable Workflow instance; when it did not,
 * this says the run is *stopping* and that it may keep executing — it never claims
 * the work halted. Even on success it repeats that side effects already sent
 * cannot be recalled, because they cannot.
 */
function RunActions({
  runId,
  status,
  canRerun,
}: {
  runId: string;
  status: RunStatus;
  canRerun: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"rerun" | "cancel" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const canCancel = CANCELLABLE.has(status);
  if (!canRerun && !canCancel) return null;

  async function post(path: string): Promise<{ res: Response; body: unknown }> {
    const res = await fetch(`${RUNTIME}/api/runs/${runId}/${path}`, {
      method: "POST",
      headers: { ...(await runtimeAuthHeader()), "Content-Type": "application/json" },
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* keep null; handled by status */ }
    return { res, body };
  }

  async function onRerun() {
    setBusy("rerun");
    setNotice(null);
    try {
      const { res, body } = await post("rerun");
      if (res.status === 422) {
        const err = body as ErrorBody;
        setNotice({
          tone: "err",
          title: "Not re-run.",
          text: err.error ?? "This run's saved input no longer matches the orchestration's input schema.",
          issues: issueLines(err.issues),
        });
        return;
      }
      if (!res.ok) {
        setNotice({
          tone: "err",
          title: "Not re-run.",
          text: (body as ErrorBody)?.error ?? `The runtime answered ${res.status}.`,
        });
        return;
      }
      router.push(`/runs/${(body as RerunResult).runId}`);
    } catch {
      setNotice({ tone: "err", title: "Not re-run.", text: "Could not reach the runtime." });
    } finally {
      setBusy(null);
    }
  }

  async function onCancel() {
    setBusy("cancel");
    setConfirming(false);
    setNotice(null);
    try {
      const { res, body } = await post("cancel");
      if (res.status === 409) {
        setNotice({
          tone: "warn",
          title: "Already finished.",
          text: (body as ErrorBody)?.error ?? "This run had already settled, so there was nothing to cancel.",
        });
        return;
      }
      if (!res.ok) {
        setNotice({
          tone: "err",
          title: "Not cancelled.",
          text: (body as ErrorBody)?.error ?? `The runtime answered ${res.status}.`,
        });
        return;
      }
      const result = body as CancelResult;
      setNotice({
        tone: result.terminated ? "ok" : "warn",
        title: result.terminated ? "Cancelled." : "Stopping.",
        text: result.message,
      });
      router.refresh();
    } catch {
      setNotice({ tone: "err", title: "Not cancelled.", text: "Could not reach the runtime." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rd-actions">
      <div className="run-actions">
        {canRerun && !confirming && (
          <button className="btn" onClick={onRerun} disabled={busy !== null}>
            {busy === "rerun" ? "Re-running…" : "Re-run"}
          </button>
        )}
        {canCancel && !confirming && (
          <button className="btn ghost" onClick={() => setConfirming(true)} disabled={busy !== null}>
            {busy === "cancel" ? "Cancelling…" : "Cancel"}
          </button>
        )}
        {confirming && (
          <>
            <span className="run-actions-q">Stop this run? Work already in progress may not be undoable.</span>
            <button className="btn danger-out" onClick={onCancel} disabled={busy !== null}>
              Cancel the run
            </button>
            <button className="btn ghost" onClick={() => setConfirming(false)} disabled={busy !== null}>
              Keep running
            </button>
          </>
        )}
      </div>
      {notice && (
        <div className={`run-note is-${notice.tone}`} role="status">
          <strong>{notice.title}</strong> {notice.text}
          {notice.issues && notice.issues.length > 0 && (
            <ul>
              {notice.issues.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
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
  const startedIso = run.startedAt ?? run.createdAt;
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
        <RunActions
          runId={run.runId}
          status={run.status}
          // Non-null exactly when the caller can read the orchestration under RLS —
          // the same condition the runtime enforces before re-dispatching. See
          // RunActions' doc comment.
          canRerun={run.orchestration != null}
        />
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
        {startedIso && <span>started <LocalTime format="clock" iso={startedIso} placeholder="--:--:--" /></span>}
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
