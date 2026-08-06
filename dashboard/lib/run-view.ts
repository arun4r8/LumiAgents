/**
 * Run view model — the single derivation layer behind the redesign's signature
 * component (the embedded run card) and the run-detail timeline.
 *
 * Both surfaces render the SAME shape (`RunSnapshot`), produced in exactly one
 * place: `app/api/runs/[id]/route.ts` for the live/polled path and the run-detail
 * page for the first server render. Everything here is pure and framework-free so
 * the two can never drift.
 *
 * Two things the database does NOT give us, and how they are handled:
 *
 *  1. `orchestration.step_status` is `running | completed | failed | skipped` —
 *     there is no 'queued'. A step row only exists once the step has started, so
 *     "queued" is the absence of a row, not a status. `queuedFromPlan` recovers
 *     the queued tail from a *step plan* (see the route), and `stepState` maps
 *     the four real statuses onto the four visual states the design asks for.
 *
 *  2. Errors are `jsonb` of no fixed shape. `errorSummary` reduces one to a
 *     single plain sentence for everyone; `errorDetail` keeps the raw text for an
 *     ops-only disclosure. Neither surface ever renders JSON.stringify at a user.
 */

// ─── Status vocabularies ─────────────────────────────────────────────────────

/** orchestration.run_status */
export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** orchestration.step_status */
export type StepStatus = "running" | "completed" | "failed" | "skipped";

/** The four visual states the run card / timeline draw. */
export type StepState = "done" | "running" | "queued" | "failed" | "skipped";

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** Terminal runs settle the card: pulsing stops, polling stops. `paused` is
 *  terminal for *motion* (nothing is moving) but not for polling — an approval
 *  can resume it — so it is deliberately not in TERMINAL. */
export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export function stepState(status: string): StepState {
  switch (status) {
    case "completed": return "done";
    case "failed":    return "failed";
    case "skipped":   return "skipped";
    case "running":   return "running";
    default:          return "queued";
  }
}

// ─── View model ──────────────────────────────────────────────────────────────

export interface RunStepView {
  /** Real step rows carry their uuid; queued placeholders get `queued:<name>`. */
  id: string;
  index: number;
  name: string;
  type: string | null;
  state: StepState;
  /** Mono meta line, e.g. "128 found · 3.1s". Never JSON. */
  meta: string;
  /** Plain-language body for the timeline's tonal card. Null → no card. */
  body: string | null;
  /** Set on the running LLM step: the labelled progress bar's caption. */
  progressLabel: string | null;
  /** One plain sentence. Safe for every audience. */
  errorSummary: string | null;
  /** Raw error text. Populated for ops only — see `snapshotFor`. */
  errorDetail: string | null;
}

export interface RunSnapshot {
  runId: string;
  status: RunStatus;
  /** Null when the joined orchestration row is not readable (see RLS note in the route). */
  orchestration: string | null;
  version: number | null;
  triggeredBy: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  steps: RunStepView[];
  /** Steps done (completed + skipped) over `total`. */
  doneCount: number;
  total: number;
  progressPct: number;
  errorSummary: string | null;
  errorDetail: string | null;
  /** Drives the "Show technical detail" disclosure. */
  isOps: boolean;
}

/** What the client gets back from GET /api/runs/[id]. */
export type RunSnapshotResponse =
  | { visible: true; snapshot: RunSnapshot }
  | { visible: false };

// ─── Error handling ──────────────────────────────────────────────────────────

const MAX_SUMMARY = 180;
const MAX_DETAIL = 4000;

function firstString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = value[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function clamp(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Raw error text, for the ops-only disclosure. Objects are pretty-printed here
 * and ONLY here — the value never reaches a non-ops client (`snapshotFor` strips
 * it), and never reaches any client through the summary path.
 */
export function errorDetail(error: unknown): string | null {
  if (error == null) return null;
  if (typeof error === "string") return clamp(error, MAX_DETAIL);
  try {
    return clamp(JSON.stringify(error, null, 2), MAX_DETAIL);
  } catch {
    return clamp(String(error), MAX_DETAIL);
  }
}

/**
 * One plain sentence describing a failure. Prefers a human message the runtime
 * already wrote (`message` / `error` / `detail` / …); falls back to a generic
 * line rather than leaking a serialised object. Stack traces are cut at the
 * first frame.
 */
export function errorSummary(error: unknown): string | null {
  if (error == null) return null;

  let raw: string | null = null;
  if (typeof error === "string") {
    raw = error;
  } else if (typeof error === "object" && !Array.isArray(error)) {
    raw = firstString(error as Record<string, unknown>, [
      "message",
      "error",
      "detail",
      "description",
      "reason",
      "summary",
    ]);
  }

  if (!raw) return "The step failed without a readable message.";

  // Drop stack frames and collapse whitespace — a summary is one line.
  const firstLine = raw.split(/\n\s*at\s|\n/)[0] ?? raw;
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  return collapsed ? clamp(collapsed, MAX_SUMMARY) : "The step failed without a readable message.";
}

// ─── Step meta / body ────────────────────────────────────────────────────────

export function fmtStepDuration(startedAt: string | null, endedAt: string | null): string | null {
  if (!startedAt || !endedAt) return null;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

const COUNT_KEYS = [
  "count", "total", "found", "scored", "processed",
  "created", "updated", "matched", "inserted", "sent",
];

/**
 * A compact "128 found" style label derived from a step's output — the design's
 * step meta. Only reads shapes we understand; anything else yields null (and the
 * meta falls back to the duration alone). Never serialises the object.
 */
export function outputCount(output: unknown): string | null {
  if (Array.isArray(output)) {
    return `${output.length.toLocaleString()} ${output.length === 1 ? "item" : "items"}`;
  }
  if (output == null || typeof output !== "object") return null;

  const obj = output as Record<string, unknown>;
  for (const key of COUNT_KEYS) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return `${v.toLocaleString()} ${key}`;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      return `${v.length.toLocaleString()} ${k}`;
    }
  }
  return null;
}

/** Plain-language body for the timeline's tonal card. Null → the step has none. */
export function outputBody(output: unknown): string | null {
  if (typeof output === "string") return clamp(output, 600);
  if (output == null || typeof output !== "object" || Array.isArray(output)) return null;
  const text = firstString(output as Record<string, unknown>, [
    "summary", "message", "text", "note", "result", "description",
  ]);
  return text ? clamp(text, 600) : null;
}

export interface RawStep {
  id: string;
  step_index: number;
  step_name: string;
  step_type: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  output: unknown;
  error: unknown;
}

function isLlm(type: string | null): boolean {
  return type === "llm_decide" || type === "llm_extract";
}

/** Build the view for one real step row. */
export function toStepView(step: RawStep, total: number): RunStepView {
  const state = stepState(step.status);
  const duration = fmtStepDuration(step.started_at, step.ended_at);
  const count = outputCount(step.output);

  let meta: string;
  if (state === "running") {
    meta = "running…";
  } else if (state === "failed") {
    meta = duration ? `failed · ${duration}` : "failed";
  } else if (state === "skipped") {
    meta = "skipped";
  } else {
    meta = [count, duration].filter(Boolean).join(" · ") || "done";
  }

  const summary = errorSummary(step.error);

  return {
    id: step.id,
    index: step.step_index,
    name: step.step_name,
    type: step.step_type,
    state,
    meta,
    body: summary ?? outputBody(step.output),
    progressLabel:
      state === "running" && isLlm(step.step_type)
        ? `Working: step ${step.step_index + 1} of ${total}`
        : null,
    errorSummary: summary,
    errorDetail: errorDetail(step.error),
  };
}

/** A placeholder row for a step the run has not reached yet. */
export function toQueuedView(name: string, index: number): RunStepView {
  return {
    id: `queued:${index}:${name}`,
    index,
    name,
    type: null,
    state: "queued",
    meta: "queued",
    body: null,
    progressLabel: null,
    errorSummary: null,
    errorDetail: null,
  };
}

/**
 * The queued tail: plan entries after the last one the run has actually reached.
 * Returns [] when there is no usable plan, which is the correct degradation —
 * the card then simply shows the steps it can see.
 */
export function queuedFromPlan(plan: string[], observed: string[]): string[] {
  if (plan.length === 0) return [];
  const seen = new Set(observed);
  let cursor = -1;
  for (let i = 0; i < plan.length; i++) {
    if (seen.has(plan[i]!)) cursor = i;
  }
  return plan.slice(cursor + 1).filter((name) => !seen.has(name));
}

// ─── Snapshot assembly ───────────────────────────────────────────────────────

export interface RawRun {
  id: string;
  status: string;
  triggered_by: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  error: unknown;
  orchestration: string | null;
  version: number | null;
}

/**
 * Assemble the snapshot both surfaces render.
 *
 * `isOps` is the ONLY gate on raw error text: when false, every `errorDetail` is
 * dropped server-side, so a non-ops client never receives it — the disclosure is
 * not merely hidden in the DOM.
 */
export function snapshotFor(
  run: RawRun,
  steps: RawStep[],
  queuedNames: string[],
  isOps: boolean,
): RunSnapshot {
  const ordered = [...steps].sort((a, b) => a.step_index - b.step_index);
  const total = ordered.length + queuedNames.length;

  const views: RunStepView[] = ordered.map((s) => toStepView(s, total));
  const maxIndex = ordered.length > 0 ? ordered[ordered.length - 1]!.step_index : -1;
  queuedNames.forEach((name, i) => views.push(toQueuedView(name, maxIndex + 1 + i)));

  const doneCount = views.filter((v) => v.state === "done" || v.state === "skipped").length;
  const failed = views.some((v) => v.state === "failed") || run.status === "failed";
  // A failed run's bar fills to where it got to, not to 100%.
  const progressPct =
    total === 0 ? 0 : Math.min(100, Math.round((doneCount / total) * 100));

  const runSummary =
    errorSummary(run.error) ??
    (failed
      ? views.find((v) => v.state === "failed")?.errorSummary ?? "The run failed."
      : null);

  const snapshot: RunSnapshot = {
    runId: run.id,
    status: (run.status as RunStatus) ?? "pending",
    orchestration: run.orchestration,
    version: run.version,
    triggeredBy: run.triggered_by,
    createdAt: run.created_at,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    steps: views,
    doneCount,
    total,
    progressPct,
    errorSummary: runSummary,
    errorDetail: errorDetail(run.error),
    isOps,
  };

  if (!isOps) {
    snapshot.errorDetail = null;
    for (const step of snapshot.steps) step.errorDetail = null;
  }

  return snapshot;
}

// ─── Formatting shared by both surfaces ──────────────────────────────────────

/** mm:ss (or h:mm:ss past an hour) — the card's elapsed readout. */
export function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Elapsed for a run: frozen at `endedAt` once it has one, else live against `now`. */
export function elapsedMs(snapshot: RunSnapshot, now: number): number {
  const start = snapshot.startedAt ?? snapshot.createdAt;
  if (!start) return 0;
  const end = snapshot.endedAt ? new Date(snapshot.endedAt).getTime() : now;
  return end - new Date(start).getTime();
}

/** run_8f2c…41 — the design's dimmed, shortened run id. */
export function shortRunId(id: string): string {
  const bare = id.replace(/-/g, "");
  if (bare.length <= 10) return `run_${bare}`;
  return `run_${bare.slice(0, 4)}…${bare.slice(-2)}`;
}
