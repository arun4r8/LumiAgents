"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { StepsTimeline } from "@/components/steps-timeline";
import { StatusBadge } from "@/components/lumi";

// ── Minimal types ────────────────────────────────────────────────────────────

export interface RunStep {
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
  run_id: string;
}

export interface Run {
  id: string;
  status: string;
  orchestration_id: string | null;
  triggered_by: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

interface RunRealtimeProps {
  runId: string;
  initialSteps: RunStep[];
  initialRun: Run;
}

// ── Component ────────────────────────────────────────────────────────────────

export function RunRealtime({ runId, initialSteps, initialRun }: RunRealtimeProps) {
  const [steps, setSteps] = useState<RunStep[]>(initialSteps);
  const [run, setRun] = useState<Run>(initialRun);

  const isInflight = run.status === "running" || run.status === "paused";

  useEffect(() => {
    const supabase = createClient();

    // Subscribe to run_steps inserts + updates for this run
    const stepsChannel = supabase
      .channel(`run-steps-${runId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "orchestration",
          table: "run_steps",
          filter: `run_id=eq.${runId}`,
        },
        (payload) => {
          const incoming = payload.new as RunStep;
          setSteps((prev) => {
            // Avoid duplicate if server already sent it
            if (prev.some((s) => s.id === incoming.id)) return prev;
            return [...prev, incoming].sort((a, b) => a.step_index - b.step_index);
          });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "orchestration",
          table: "run_steps",
          filter: `run_id=eq.${runId}`,
        },
        (payload) => {
          const incoming = payload.new as RunStep;
          setSteps((prev) =>
            prev.map((s) => (s.id === incoming.id ? { ...s, ...incoming } : s))
          );
        }
      )
      .subscribe();

    // Subscribe to the run record itself for status changes
    const runChannel = supabase
      .channel(`run-${runId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "orchestration",
          table: "runs",
          filter: `id=eq.${runId}`,
        },
        (payload) => {
          const incoming = payload.new as Run;
          setRun((prev) => ({ ...prev, ...incoming }));
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(stepsChannel);
      void supabase.removeChannel(runChannel);
    };
  }, [runId]);

  const completedCount = steps.filter((s) => s.status === "completed").length;

  return (
    <>
      {/* Steps section header */}
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
        <div className="meta" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StatusBadge status={run.status} />
          <span>
            {completedCount} of {steps.length} completed
          </span>
        </div>
      </div>

      <div className="card" style={{ padding: "16px 18px" }}>
        <StepsTimeline steps={steps} />
      </div>
    </>
  );
}
