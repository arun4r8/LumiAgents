"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Clock,
  Zap,
  Terminal,
  Brain,
  Wrench,
  Check,
  X,
  AlertTriangle,
} from "lucide-react";
import { StatusBadge, fmtAbs, fmtDuration } from "@/components/lumi";

// ── Types ────────────────────────────────────────────────────────────────────

interface Run {
  id: string;
  status: string;
  triggered_by: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  input: unknown;
  output: unknown;
  error: unknown;
  orchestrations: { name: string; version: number } | null;
}

interface Step {
  id: string;
  step_index: number;
  step_name: string;
  step_type: string;
  status: string;
  input: unknown;
  output: unknown;
  error: unknown;
  started_at: string | null;
  ended_at: string | null;
  llm_model: string | null;
  llm_prompt: string | null;
  llm_response: string | null;
  llm_input_tokens: number | null;
  llm_output_tokens: number | null;
}

interface ToolCall {
  id: string;
  run_step_id: string;
  tool_name: string;
  request: unknown;
  response: unknown;
  status: string;
  status_code: number | null;
  latency_ms: number | null;
  ended_at: string | null;
}

interface Props {
  run: Run;
  steps: Step[];
  toolCalls: ToolCall[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusChipClass(status: string): string {
  switch (status) {
    case "completed": return "chip ok";
    case "failed":    return "chip err";
    case "running":   return "chip info";
    case "paused":    return "chip warn";
    default:          return "chip muted";
  }
}

function stepTypeIcon(stepType: string) {
  const size = { width: 13, height: 13 };
  if (stepType === "llm_decide" || stepType === "llm_extract") {
    return <Brain style={size} />;
  }
  if (stepType === "await_approval") {
    return <Clock style={size} />;
  }
  if (stepType === "tool") {
    return <Wrench style={size} />;
  }
  return <Zap style={size} />;
}

function stepTypeChipClass(stepType: string): string {
  switch (stepType) {
    case "llm_decide":
    case "llm_extract":
      return "chip accent";
    case "await_approval":
      return "chip warn";
    case "tool":
      return "chip info";
    default:
      return "chip muted";
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isLlmStep(step: Step): boolean {
  return step.step_type === "llm_decide" || step.step_type === "llm_extract";
}

// ── Tool call status icon ─────────────────────────────────────────────────────

function ToolStatusIcon({ status }: { status: string }) {
  const size = { width: 12, height: 12 };
  if (status === "completed" || status === "success") {
    return <Check style={{ ...size, color: "var(--ok)" }} />;
  }
  if (status === "failed" || status === "error") {
    return <X style={{ ...size, color: "var(--err)" }} />;
  }
  return <AlertTriangle style={{ ...size, color: "var(--warn)" }} />;
}

// ── ToolCallRow ───────────────────────────────────────────────────────────────

function ToolCallRow({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 0,
        background: "var(--bg)",
        overflow: "hidden",
        marginTop: 4,
      }}
    >
      {/* Header row */}
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <Terminal style={{ width: 12, height: 12, color: "var(--ink-3)", flexShrink: 0 }} />
        <span className="mono" style={{ fontSize: 12, color: "var(--ink)", flex: 1 }}>
          {tc.tool_name}
        </span>
        <ToolStatusIcon status={tc.status} />
        {tc.status_code != null && (
          <span className="mono muted" style={{ fontSize: 11 }}>
            {tc.status_code}
          </span>
        )}
        {tc.latency_ms != null && (
          <span className="mono muted" style={{ fontSize: 11 }}>
            {tc.latency_ms}ms
          </span>
        )}
        {open ? (
          <ChevronUp style={{ width: 12, height: 12, color: "var(--ink-3)" }} />
        ) : (
          <ChevronDown style={{ width: 12, height: 12, color: "var(--ink-3)" }} />
        )}
      </div>

      {/* Expanded detail */}
      {open && (
        <div
          style={{
            borderTop: "1px solid var(--line)",
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            background: "var(--bg-1)",
          }}
        >
          <div>
            <div
              className="mono"
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--ink-3)",
                fontWeight: 600,
                marginBottom: 4,
              }}
            >
              Request
            </div>
            <pre
              className="mono"
              style={{
                margin: 0,
                fontSize: 11.5,
                background: "var(--bg)",
                border: "1px solid var(--line)",
                borderRadius: 0,
                padding: "8px 10px",
                maxHeight: 200,
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                overflowWrap: "break-word",
                color: "var(--ink-1)",
              }}
            >
              {prettyJson(tc.request)}
            </pre>
          </div>
          {tc.response != null && (
            <div>
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--ink-3)",
                  fontWeight: 600,
                  marginBottom: 4,
                }}
              >
                Response
              </div>
              <pre
                className="mono"
                style={{
                  margin: 0,
                  fontSize: 11.5,
                  background: "var(--bg)",
                  border: "1px solid var(--line)",
                  borderRadius: 0,
                  padding: "8px 10px",
                  maxHeight: 200,
                  overflowY: "auto",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "break-word",
                  color: "var(--ink-1)",
                }}
              >
                {prettyJson(tc.response)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── StepRow ───────────────────────────────────────────────────────────────────

function StepRow({
  step,
  isLast,
  toolCallsForStep,
}: {
  step: Step;
  isLast: boolean;
  toolCallsForStep: ToolCall[];
}) {
  const [open, setOpen] = useState(
    step.status === "failed" || step.status === "running" || step.status === "paused"
  );

  const hasDetail =
    step.input != null ||
    step.output != null ||
    step.error != null ||
    step.llm_prompt != null ||
    step.llm_response != null ||
    toolCallsForStep.length > 0;

  const duration = fmtDuration(step.started_at, step.ended_at);
  const isLlm = isLlmStep(step);

  return (
    <div className="tl-step">
      {/* Rail */}
      <div className="tl-rail">
        <div className={`node ${step.status}`}>
          {step.status === "completed" && (
            <Check style={{ width: 8, height: 8, color: "white" }} />
          )}
          {step.status === "failed" && (
            <X style={{ width: 8, height: 8, color: "white" }} />
          )}
        </div>
        {!isLast && <div className="line" />}
      </div>

      {/* Body */}
      <div className="tl-body">
        {/* Header row */}
        <div
          className="tl-head"
          onClick={hasDetail ? () => setOpen((v) => !v) : undefined}
          style={{ cursor: hasDetail ? "pointer" : "default" }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--ink-3)", display: "flex", alignItems: "center" }}>
              {stepTypeIcon(step.step_type)}
            </span>
            <span className="tl-name">{step.step_name}</span>
          </span>
          <span className={stepTypeChipClass(step.step_type)} style={{ fontSize: 10.5 }}>
            {step.step_type}
          </span>
          {step.status !== "pending" && <StatusBadge status={step.status} />}
          <span className="tl-meta">
            {/* Token counts for LLM steps */}
            {isLlm && (step.llm_input_tokens != null || step.llm_output_tokens != null) && (
              <span className="mono muted" style={{ fontSize: 11 }}>
                {step.llm_input_tokens ?? 0}in&nbsp;/&nbsp;{step.llm_output_tokens ?? 0}out
              </span>
            )}
            {duration !== "-" && (
              <span>{duration}</span>
            )}
            {hasDetail && (
              open
                ? <ChevronUp style={{ width: 12, height: 12, color: "var(--ink-3)" }} />
                : <ChevronDown style={{ width: 12, height: 12, color: "var(--ink-3)" }} />
            )}
          </span>
        </div>

        {/* Expanded detail */}
        {open && hasDetail && (
          <div className="tl-detail">
            {/* LLM metadata row */}
            {isLlm && step.llm_model && (
              <div className="kv">
                <span>
                  <span className="k">model</span>{" "}
                  <span className="v">{step.llm_model}</span>
                </span>
                {step.llm_input_tokens != null && (
                  <span>
                    <span className="k">input tokens</span>{" "}
                    <span className="v">{step.llm_input_tokens.toLocaleString()}</span>
                  </span>
                )}
                {step.llm_output_tokens != null && (
                  <span>
                    <span className="k">output tokens</span>{" "}
                    <span className="v">{step.llm_output_tokens.toLocaleString()}</span>
                  </span>
                )}
              </div>
            )}

            {/* LLM Prompt */}
            {isLlm && step.llm_prompt && (
              <div>
                <div
                  style={{
                    fontSize: 10.5,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.06em",
                    color: "var(--ink-3)",
                    fontWeight: 600,
                    marginBottom: 4,
                  }}
                >
                  Prompt
                </div>
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    fontSize: 12,
                    background: "var(--bg)",
                    border: "1px solid var(--line)",
                    borderRadius: 0,
                    padding: "9px 11px",
                    maxHeight: 200,
                    overflowY: "auto",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "break-word",
                    color: "var(--ink-1)",
                  }}
                >
                  {step.llm_prompt}
                </pre>
              </div>
            )}

            {/* LLM Response */}
            {isLlm && step.llm_response && (
              <div>
                <div
                  style={{
                    fontSize: 10.5,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.06em",
                    color: "var(--ink-3)",
                    fontWeight: 600,
                    marginBottom: 4,
                  }}
                >
                  Response
                </div>
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    fontSize: 12,
                    background: "var(--bg)",
                    border: "1px solid var(--line)",
                    borderRadius: 0,
                    padding: "9px 11px",
                    maxHeight: 200,
                    overflowY: "auto",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "break-word",
                    color: "var(--ink-1)",
                  }}
                >
                  {step.llm_response}
                </pre>
              </div>
            )}

            {/* Error */}
            {step.error != null && (
              <div>
                <div
                  style={{
                    fontSize: 10.5,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.06em",
                    color: "var(--err)",
                    fontWeight: 600,
                    marginBottom: 4,
                  }}
                >
                  Error
                </div>
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    fontSize: 12,
                    background: "var(--err-soft)",
                    border: "1px solid var(--err-line)",
                    borderRadius: 0,
                    padding: "9px 11px",
                    maxHeight: 200,
                    overflowY: "auto",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "break-word",
                    color: "var(--err)",
                  }}
                >
                  {typeof step.error === "string"
                    ? step.error
                    : prettyJson(step.error)}
                </pre>
              </div>
            )}

            {/* Input JSON */}
            {step.input != null && (
              <div>
                <div
                  style={{
                    fontSize: 10.5,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.06em",
                    color: "var(--ink-3)",
                    fontWeight: 600,
                    marginBottom: 4,
                  }}
                >
                  Input
                </div>
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    fontSize: 12,
                    background: "var(--bg)",
                    border: "1px solid var(--line)",
                    borderRadius: 0,
                    padding: "9px 11px",
                    maxHeight: 200,
                    overflowY: "auto",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "break-word",
                    color: "var(--ink-1)",
                  }}
                >
                  {prettyJson(step.input)}
                </pre>
              </div>
            )}

            {/* Output JSON */}
            {step.output != null && step.error == null && (
              <div>
                <div
                  style={{
                    fontSize: 10.5,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.06em",
                    color: "var(--ink-3)",
                    fontWeight: 600,
                    marginBottom: 4,
                  }}
                >
                  Output
                </div>
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    fontSize: 12,
                    background: "var(--bg)",
                    border: "1px solid var(--line)",
                    borderRadius: 0,
                    padding: "9px 11px",
                    maxHeight: 200,
                    overflowY: "auto",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "break-word",
                    color: "var(--ink-1)",
                  }}
                >
                  {typeof step.output === "string"
                    ? step.output
                    : prettyJson(step.output)}
                </pre>
              </div>
            )}

            {/* Tool calls */}
            {toolCallsForStep.length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: 10.5,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.06em",
                    color: "var(--ink-3)",
                    fontWeight: 600,
                    marginBottom: 6,
                  }}
                >
                  Tool calls ({toolCallsForStep.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {toolCallsForStep.map((tc) => (
                    <ToolCallRow key={tc.id} tc={tc} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function RunDetailClient({ run, steps, toolCalls }: Props) {
  // Group tool calls by step id for O(1) lookup
  const toolCallsByStep = new Map<string, ToolCall[]>();
  for (const tc of toolCalls) {
    const list = toolCallsByStep.get(tc.run_step_id) ?? [];
    list.push(tc);
    toolCallsByStep.set(tc.run_step_id, list);
  }

  const orch = run.orchestrations;
  const completedCount = steps.filter((s) => s.status === "completed").length;
  const isInflight = run.status === "running" || run.status === "paused";

  return (
    <div className="page view-fade">
      {/* ── Page header ── */}
      <div className="page-h">
        <div>
          <Link
            href="/runs"
            className="btn ghost sm"
            style={{ marginBottom: 8, marginLeft: -8 }}
          >
            <ArrowLeft style={{ width: 12, height: 12 }} />
            All runs
          </Link>
          <h1 className="mono" style={{ fontSize: 17 }}>
            {orch?.name ?? "Run"}
          </h1>
          <div className="sub">Run detail</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {orch?.version != null && (
            <span className="chip muted mono" style={{ fontSize: 11 }}>
              v{orch.version}
            </span>
          )}
          <StatusBadge status={run.status} />
        </div>
      </div>

      {/* ── Run header card ── */}
      <div className="runh">
        <div className="left">
          <div className="row gap-md">
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-2)" }}>
              {run.id}
            </span>
          </div>
          <div className="meta">
            <span>
              <span className="lbl">Created</span>
              <span className="v">{fmtAbs(run.created_at)}</span>
            </span>
            {run.started_at && (
              <span>
                <span className="lbl">Started</span>
                <span className="v">{fmtAbs(run.started_at)}</span>
              </span>
            )}
            <span>
              <span className="lbl">Duration</span>
              <span className="v">{fmtDuration(run.started_at, run.ended_at)}</span>
            </span>
            {run.triggered_by && (
              <span>
                <span className="lbl">Triggered by</span>
                <span className="v">{run.triggered_by}</span>
              </span>
            )}
          </div>
        </div>
        <div className="right" style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          {isInflight && (
            <span
              className="live-dot"
              title="Run is in progress"
              style={{ marginTop: 6 }}
            />
          )}
        </div>
      </div>

      {/* ── Steps timeline ── */}
      <div className="section-h">
        <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Steps
          {isInflight && (
            <span
              className="live-dot"
              title="Receiving live updates"
              style={{ verticalAlign: "middle" }}
            />
          )}
        </h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {completedCount} of {steps.length} completed
        </span>
      </div>

      <div className="card" style={{ padding: "16px 18px" }}>
        {steps.length === 0 ? (
          <div className="muted" style={{ padding: "20px 0", fontSize: 13 }}>
            No steps recorded yet.
          </div>
        ) : (
          <div className="tl">
            {steps.map((step, idx) => (
              <StepRow
                key={step.id}
                step={step}
                isLast={idx === steps.length - 1}
                toolCallsForStep={toolCallsByStep.get(step.id) ?? []}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Run output / error ── */}
      {run.status === "completed" && run.output != null && (
        <>
          <div className="section-h" style={{ marginTop: 22 }}>
            <h3>Output</h3>
          </div>
          <div className="card pad">
            <pre
              className="mono"
              style={{
                margin: 0,
                fontSize: 12.5,
                color: "var(--ink-1)",
                whiteSpace: "pre-wrap",
                overflowWrap: "break-word",
                maxHeight: 400,
                overflowY: "auto",
              }}
            >
              {prettyJson(run.output)}
            </pre>
          </div>
        </>
      )}

      {run.status === "failed" && run.error != null && (
        <>
          <div className="section-h" style={{ marginTop: 22 }}>
            <h3 style={{ color: "var(--err)" }}>
              <AlertTriangle style={{ width: 14, height: 14, display: "inline", marginRight: 6, verticalAlign: "text-bottom" }} />
              Error
            </h3>
          </div>
          <div
            className="card pad"
            style={{
              background: "var(--err-soft)",
              borderColor: "var(--err-line)",
            }}
          >
            <pre
              className="mono"
              style={{
                margin: 0,
                fontSize: 12.5,
                color: "var(--err)",
                whiteSpace: "pre-wrap",
                overflowWrap: "break-word",
                maxHeight: 400,
                overflowY: "auto",
              }}
            >
              {typeof run.error === "string"
                ? run.error
                : prettyJson(run.error)}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
