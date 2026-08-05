"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isTerminal, type RunSnapshot, type RunSnapshotResponse } from "@/lib/run-view";

/**
 * Live run state for the embedded run card and the run-detail timeline.
 *
 * Mechanism: polling GET /api/runs/:id, not a Supabase realtime subscription.
 *
 *   • That endpoint reads through the caller's own session, so live updates are
 *     RLS-scoped by construction — an enduser gets exactly the runs RLS grants
 *     them and no service-role read path exists.
 *   • `orchestration.runs` / `run_steps` are not added to the `supabase_realtime`
 *     publication anywhere in supabase/migrations, so the existing
 *     `overview-realtime.tsx` subscription is best-effort. The run card is the
 *     screen's primary content and has to be right, not best-effort.
 *   • The card needs *step* transitions, not just run status, which would mean a
 *     second subscription per card — and a chat transcript can hold several cards.
 *     One conditional poll per in-flight card is cheaper than N websockets.
 *
 * Cost control: polling stops the moment the run reaches a terminal status,
 * pauses while the tab is hidden (and refetches on return), and backs off from
 * FAST to SLOW after the run has been watched for a while.
 */

const FAST_MS = 1_500;
const SLOW_MS = 5_000;
const BACKOFF_AFTER_MS = 60_000;

export interface RunLive {
  snapshot: RunSnapshot | null;
  /** False once the server has told us this run is not readable by this user. */
  visible: boolean;
  loading: boolean;
  /** True while the card is still receiving updates (non-terminal + polling). */
  live: boolean;
  refresh: () => void;
}

export function useRunLive(runId: string, initial?: RunSnapshot | null): RunLive {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(initial ?? null);
  const [visible, setVisible] = useState(true);
  const [loading, setLoading] = useState(initial == null);

  // The poll loop reads the current status from a ref so that a status change
  // does not tear the interval down and rebuild it. `fetchOnce` keeps it fresh.
  const statusRef = useRef<string>(initial?.status ?? "pending");
  // The server-render seed is read once, on mount, by design.
  const seedRef = useRef<RunSnapshot | null>(initial ?? null);
  const startedAtRef = useRef<number>(0);
  const inFlight = useRef(false);

  const fetchOnce = useCallback(async (signal?: AbortSignal) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(`/api/runs/${runId}`, {
        signal: signal ?? null,
        cache: "no-store",
      });
      if (!res.ok) {
        // 401/500: keep whatever we last rendered rather than blanking the card.
        return;
      }
      const body = (await res.json()) as RunSnapshotResponse;
      if (body.visible) {
        statusRef.current = body.snapshot.status;
        setSnapshot(body.snapshot);
        setVisible(true);
      } else {
        setVisible(false);
      }
    } catch {
      // Network hiccup, or an in-flight request aborted on unmount: the next tick
      // recovers and the card keeps showing its last good state meanwhile.
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [runId]);

  const refresh = useCallback(() => {
    void fetchOnce();
  }, [fetchOnce]);

  useEffect(() => {
    const controller = new AbortController();
    startedAtRef.current = Date.now();

    // A run the server already handed us settled needs no network at all.
    const seed = seedRef.current;
    const settledOnArrival = seed != null && isTerminal(seed.status);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const schedule = (delay: number) => {
      timer = setTimeout(() => {
        if (stopped) return;
        const poll =
          typeof document === "undefined" || document.visibilityState === "visible"
            ? fetchOnce(controller.signal)
            : Promise.resolve();
        void poll.then(() => {
          if (stopped || isTerminal(statusRef.current)) return; // settled: stop for good
          const watched = Date.now() - startedAtRef.current;
          schedule(watched > BACKOFF_AFTER_MS ? SLOW_MS : FAST_MS);
        });
      }, delay);
    };

    // delay 0 rather than an inline call: the first fetch is still immediate, but
    // it lands outside the effect body instead of setting state synchronously in it.
    if (!settledOnArrival) schedule(0);

    const onVisible = () => {
      if (document.visibilityState === "visible" && !isTerminal(statusRef.current)) {
        void fetchOnce(controller.signal);
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [runId, fetchOnce]);

  const status = snapshot?.status ?? "pending";
  return {
    snapshot,
    visible,
    loading,
    live: visible && !isTerminal(status),
    refresh,
  };
}

/**
 * A 1s ticker, used only for the elapsed readout on an in-flight run. Stops dead
 * when `active` is false so a settled card does no work at all.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
