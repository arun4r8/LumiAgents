"use client";

import { useState, useTransition } from "react";
import { Trophy, Trash2, Loader2, ExternalLink } from "lucide-react";
import type { Award } from "@/app/(dashboard)/awards/page";

interface Props {
  awards: Award[];
  dismissAward: (formData: FormData) => Promise<void>;
}

type RecFilter = "all" | "apply" | "consider" | "skip";
type TypeFilter = "all" | "industry" | "government";

function Badge({ text, bg, fg }: { text: string; bg: string; fg: string }) {
  return (
    <span style={{ display: "inline-block", background: bg, color: fg, borderRadius: 0, padding: "2px 9px", fontSize: 11, fontWeight: 700, textTransform: "capitalize", whiteSpace: "nowrap" }}>
      {text}
    </span>
  );
}

const REC_COLORS: Record<string, { bg: string; fg: string }> = {
  apply: { bg: "#dcfce7", fg: "#166534" },
  consider: { bg: "#fef9c3", fg: "#854d0e" },
  skip: { bg: "#f3f4f6", fg: "#6b7280" },
};
const PRESTIGE_COLORS: Record<string, { bg: string; fg: string }> = {
  high: { bg: "#e0e7ff", fg: "#3730a3" },
  medium: { bg: "#dbeafe", fg: "#1e40af" },
  low: { bg: "#f3f4f6", fg: "#6b7280" },
};
const EFFORT_COLORS: Record<string, { bg: string; fg: string }> = {
  low: { bg: "#dcfce7", fg: "#166534" },
  medium: { bg: "#fef9c3", fg: "#854d0e" },
  high: { bg: "#fee2e2", fg: "#991b1b" },
};

function fitColor(score: number | null): { bg: string; fg: string } {
  if (score == null) return { bg: "#f3f4f6", fg: "#6b7280" };
  if (score >= 7) return { bg: "#dcfce7", fg: "#166534" };
  if (score >= 5) return { bg: "#fef9c3", fg: "#854d0e" };
  return { bg: "#f3f4f6", fg: "#6b7280" };
}

export function AwardsClient({ awards, dismissAward }: Props) {
  const [rec, setRec] = useState<RecFilter>("all");
  const [type, setType] = useState<TypeFilter>("all");

  const filtered = awards.filter(
    (a) => (rec === "all" || a.recommendation === rec) && (type === "all" || a.award_type === type),
  );
  const applyCount = awards.filter((a) => a.recommendation === "apply").length;

  const pill = (active: boolean): React.CSSProperties => ({
    padding: "4px 12px", borderRadius: 0, fontSize: 12.5, fontWeight: 500, cursor: "pointer",
    border: "1px solid var(--line)", background: active ? "var(--ink)" : "transparent",
    color: active ? "var(--bg)" : "var(--ink-2)", textTransform: "capitalize",
  });

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Awards</h1>
          <div className="sub">
            {awards.length === 0
              ? "No awards on the radar yet."
              : `${awards.length} award${awards.length !== 1 ? "s" : ""} · ${applyCount} recommended to apply`}
          </div>
        </div>
      </div>

      <p className="sub" style={{ marginBottom: 16, maxWidth: 760 }}>
        Cleo&apos;s weekly sweep for industry recognition and government small-business award programs,
        scored on <strong>fit</strong>, <strong>prestige</strong>, and application <strong>effort</strong>.
        Focus on the <strong>apply</strong>-rated ones with near deadlines; dismiss anything off-target.
      </p>

      {awards.length > 0 && (
        <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {(["all", "apply", "consider", "skip"] as RecFilter[]).map((r) => (
              <button key={r} style={pill(rec === r)} onClick={() => setRec(r)}>{r}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {(["all", "industry", "government"] as TypeFilter[]).map((t) => (
              <button key={t} style={pill(type === t)} onClick={() => setType(t)}>{t}</button>
            ))}
          </div>
        </div>
      )}

      {awards.length === 0 ? (
        <div className="empty">
          <div className="ico"><Trophy /></div>
          <h4>No awards yet.</h4>
          <p>Cleo&apos;s weekly award sweep hasn&apos;t surfaced anything yet — or run a sweep from the Cleo chat.</p>
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)" }}>
                {["Award", "Type", "Deadline", "Fit", "Prestige", "Effort", "Rec.", ""].map((h) => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-3)", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <AwardRow key={a.id} award={a} dismissAward={dismissAward} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AwardRow({ award: a, dismissAward }: { award: Award; dismissAward: Props["dismissAward"] }) {
  const [pending, start] = useTransition();
  const deadline = a.application_deadline ?? a.nomination_deadline;
  const fit = fitColor(a.fit_score);

  return (
    <tr style={{ borderBottom: "1px solid var(--line)" }}>
      <td style={{ padding: "12px 14px", maxWidth: 340 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>
          {a.source_url ? (
            <a href={a.source_url} target="_blank" rel="noreferrer" style={{ color: "var(--ink)", textDecoration: "none" }}>
              {a.title} <ExternalLink style={{ width: 11, height: 11, verticalAlign: "middle", color: "var(--ink-3)" }} />
            </a>
          ) : a.title}
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
          {[a.sponsor, a.category].filter(Boolean).join(" · ") || "—"}
        </div>
      </td>
      <td style={{ padding: "12px 14px" }}>
        <Badge text={a.award_type === "government" ? "Gov" : "Industry"} bg="#eef2ff" fg="#4338ca" />
      </td>
      <td style={{ padding: "12px 14px", fontSize: 12.5, color: "var(--ink-2)", whiteSpace: "nowrap" }}>{deadline ?? "—"}</td>
      <td style={{ padding: "12px 14px" }}>
        <span style={{ display: "inline-block", background: fit.bg, color: fit.fg, borderRadius: 0, padding: "2px 10px", fontWeight: 700, fontSize: 12.5 }}>{a.fit_score ?? "—"}</span>
      </td>
      <td style={{ padding: "12px 14px" }}>{a.prestige ? <Badge text={a.prestige} {...(PRESTIGE_COLORS[a.prestige] ?? PRESTIGE_COLORS.low)} /> : "—"}</td>
      <td style={{ padding: "12px 14px" }}>{a.effort ? <Badge text={a.effort} {...(EFFORT_COLORS[a.effort] ?? EFFORT_COLORS.medium)} /> : "—"}</td>
      <td style={{ padding: "12px 14px" }}><Badge text={a.recommendation} {...(REC_COLORS[a.recommendation] ?? REC_COLORS.skip)} /></td>
      <td style={{ padding: "12px 14px", textAlign: "right" }}>
        <form action={(fd) => start(async () => { await dismissAward(fd); })} style={{ display: "inline" }}>
          <input type="hidden" name="id" value={a.id} />
          <button type="submit" className="btn ghost sm" disabled={pending} title="Dismiss (remove from the radar)">
            {pending ? <Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> : <Trash2 style={{ width: 13, height: 13 }} />}
          </button>
        </form>
      </td>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </tr>
  );
}
