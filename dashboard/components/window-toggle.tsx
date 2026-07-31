"use client";

import { SPEND_WINDOWS, type SpendWindow } from "@/lib/spend";

// Compact segmented control for the 24h / 7d / 30d spend window.
export function WindowToggle({
  value,
  onChange,
}: {
  value: SpendWindow;
  onChange: (w: SpendWindow) => void;
}) {
  return (
    <div className="winseg" role="group" aria-label="Spend window">
      {SPEND_WINDOWS.map((w) => (
        <button
          key={w.key}
          type="button"
          className={value === w.key ? "active" : ""}
          aria-pressed={value === w.key}
          onClick={() => onChange(w.key)}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}
