"use client";

// Route-level error boundary for the dashboard.
// Catches failed Supabase/runtime fetches (and any render error) and offers a
// Retry, instead of falling through to the Next.js default error screen.
import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface it for local debugging / telemetry.
    console.error(error);
  }, [error]);

  return (
    <div className="page view-fade">
      <div className="empty" style={{ maxWidth: 520, margin: "48px auto 0" }}>
        <div className="ico" style={{ background: "var(--err-soft)", color: "var(--err)" }}>
          <AlertTriangle />
        </div>
        <h4>Something went wrong.</h4>
        <p>
          We couldn&apos;t load this view. This is usually a transient data or network hiccup —
          try again in a moment.
        </p>
        {error.digest && (
          <p className="mono" style={{ marginTop: 8, color: "var(--ink-3)", fontSize: 11.5 }}>
            {error.digest}
          </p>
        )}
        <button
          type="button"
          className="btn accent"
          onClick={() => reset()}
          style={{ marginTop: 16 }}
        >
          <RefreshCw /> Retry
        </button>
      </div>
    </div>
  );
}
