"use client";

import { useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { StatusBadge, fmtDuration } from "@/components/lumi";

interface Step {
  id: string;
  step_index: number;
  step_name: string;
  step_type: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  input: unknown;
  output: unknown;
  error: unknown;
  llm_model: string | null;
  llm_input_tokens: number | null;
  llm_output_tokens: number | null;
  llm_prompt: string | null;
}

export function StepsTimeline({ steps }: { steps: Step[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const step of steps) {
      if (step.status === "running" || step.status === "paused" || step.status === "failed") {
        s.add(step.id);
      }
    }
    return s;
  });

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  if (steps.length === 0) {
    return (
      <div className="muted" style={{ padding: "20px 0", fontSize: 13 }}>
        No steps recorded yet.
      </div>
    );
  }

  return (
    <div className="tl">
      {steps.map((step) => (
        <StepRow
          key={step.id}
          step={step}
          isLast={step === steps[steps.length - 1]}
          expanded={expanded.has(step.id)}
          onToggle={() => toggle(step.id)}
        />
      ))}
    </div>
  );
}

function StepRow({
  step,
  isLast,
  expanded,
  onToggle,
}: {
  step: Step;
  isLast: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const typeColor: Record<string, string> = {
    step: "muted",
    llm_decide: "accent",
    llm_extract: "info",
    await_approval: "warn",
  };
  const color = typeColor[step.step_type] ?? "muted";

  const hasDetail =
    step.input != null ||
    step.output != null ||
    step.error != null ||
    step.llm_prompt != null;

  const duration = fmtDuration(step.started_at, step.ended_at);

  return (
    <div className="tl-step">
      <div className="tl-rail">
        <div className={`node ${step.status}`}>
          {step.status === "completed" && (
            <Check style={{ width: 8, height: 8, color: "white" }} />
          )}
        </div>
        {!isLast && <div className="line" />}
      </div>
      <div className="tl-body">
        <div
          className="tl-head"
          onClick={hasDetail ? onToggle : undefined}
          style={{ cursor: hasDetail ? "pointer" : "default" }}
        >
          <span className="tl-name">{step.step_name}</span>
          <span className={`chip ${color}`}>{step.step_type}</span>
          {step.status !== "pending" && <StatusBadge status={step.status} />}
          <span className="tl-meta">
            {duration !== "-" && <span>{duration}</span>}
            {hasDetail && (
              <ChevronRight
                style={{
                  width: 12,
                  height: 12,
                  transition: "transform .15s",
                  transform: expanded ? "rotate(90deg)" : "none",
                  color: "var(--ink-3)",
                }}
              />
            )}
          </span>
        </div>

        {expanded && hasDetail && (
          <div className="tl-detail">
            {/* LLM details */}
            {step.llm_model && (
              <div className="kv">
                <span><span className="k">model</span> <span className="v">{step.llm_model}</span></span>
                {step.llm_input_tokens != null && (
                  <span><span className="k">input</span> <span className="v">{step.llm_input_tokens.toLocaleString()} tok</span></span>
                )}
                {step.llm_output_tokens != null && (
                  <span><span className="k">output</span> <span className="v">{step.llm_output_tokens.toLocaleString()} tok</span></span>
                )}
              </div>
            )}
            {step.llm_prompt && (
              <div className="prose">
                <span className="lbl">Prompt</span>
                {step.llm_prompt}
              </div>
            )}
            {/* Error */}
            {step.error != null && (
              <div className="prose" style={{ borderLeftColor: "var(--err-line)", background: "var(--err-soft)" }}>
                <span className="lbl" style={{ color: "var(--err)" }}>Error</span>
                {typeof step.error === "string" ? step.error : JSON.stringify(step.error, null, 2)}
              </div>
            )}
            {/* Output */}
            {step.output != null && step.error == null && (
              <div className="prose">
                <span className="lbl">Output</span>
                {typeof step.output === "string" ? step.output : JSON.stringify(step.output, null, 2)}
              </div>
            )}
            {/* Generic key-value for input */}
            {step.input != null && typeof step.input === "object" && !Array.isArray(step.input) && (
              <div className="kv">
                {Object.entries(step.input as Record<string, unknown>)
                  .slice(0, 8)
                  .map(([k, v]) => (
                    <span key={k}>
                      <span className="k">{k}</span>{" "}
                      <span className="v">
                        {typeof v === "number" ? v.toLocaleString() : String(v ?? "-")}
                      </span>
                    </span>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
