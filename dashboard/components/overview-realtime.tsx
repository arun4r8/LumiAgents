"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

interface RunChangePayload {
  id: string;
  status: string;
}

interface OverviewRealtimeProps {
  onRunChange: (run: RunChangePayload) => void;
}

/**
 * Headless subscription manager: renders nothing, just subscribes to
 * `orchestration.runs` for INSERT and UPDATE events across all runs and
 * calls `onRunChange` when one arrives.
 */
export function OverviewRealtime({ onRunChange }: OverviewRealtimeProps) {
  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("overview-runs")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "orchestration",
          table: "runs",
        },
        (payload) => {
          const r = payload.new as RunChangePayload;
          onRunChange({ id: r.id, status: r.status });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "orchestration",
          table: "runs",
        },
        (payload) => {
          const r = payload.new as RunChangePayload;
          onRunChange({ id: r.id, status: r.status });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [onRunChange]);

  // Headless: no rendered output
  return null;
}
