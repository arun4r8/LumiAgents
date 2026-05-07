"use client";

import { useState } from "react";
import { fmtTimeAgo } from "@/components/lumi";

interface Decided {
  id: string;
  status: string;
  prompt: string;
  decided_at: string | null;
  decided_by: string | null;
  run_id: string | null;
  runs: { id: string; orchestrations: { name: string } | null } | null;
}

export function ApprovalsClient({ decided }: { decided: Decided[] }) {
  const [show, setShow] = useState(false);

  return (
    <>
      <div style={{ marginTop: 28, display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>History</h3>
        <button className="btn sm" onClick={() => setShow((v) => !v)}>
          {show ? "Hide" : "Show"} ({decided.length})
        </button>
      </div>
      {show && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {decided.map((a) => {
            const ok = a.status === "approved";
            const orchName = a.runs?.orchestrations?.name ?? "—";
            return (
              <div key={a.id} className="decided-row">
                <span className={`chip ${ok ? "ok" : "warn"}`}>{a.status}</span>
                <span className="mono" style={{ fontSize: 12.5, color: "var(--ink-1)" }}>{orchName}</span>
                <span
                  className="muted truncate"
                  style={{ flex: 1, fontSize: 12.5 }}
                >
                  {a.prompt}
                </span>
                <span className="muted mono" style={{ fontSize: 11.5 }}>
                  {fmtTimeAgo(a.decided_at ?? undefined)}
                </span>
                {a.run_id && (
                  <a href={`/runs/${a.run_id}`} className="btn ghost sm">
                    View run
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
