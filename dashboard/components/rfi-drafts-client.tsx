"use client";

import { useState, useTransition } from "react";
import { FileText, Sparkles, Loader2, Trash2, Copy, Check, ChevronRight, ChevronDown, AlertTriangle, ClipboardList, ShieldCheck } from "lucide-react";
import type { RfiDraft, OppOption } from "@/app/(dashboard)/records/bd/rfi-drafts";

interface Props {
  drafts: RfiDraft[];
  opportunities: OppOption[];
  generateDraft: (formData: FormData) => Promise<void>;
  submitAnswers: (formData: FormData) => Promise<void>;
  deleteDraft: (formData: FormData) => Promise<void>;
}

const RATING_COLOR: Record<string, string> = {
  strong: "var(--ok)", adequate: "var(--warn)", weak: "var(--err)",
};

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function RfiDraftsClient({ drafts, opportunities, generateDraft, submitAnswers, deleteDraft }: Props) {
  const [selected, setSelected] = useState("");
  const [genPending, startGen] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [justStarted, setJustStarted] = useState(false);

  function handleGenerate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    startGen(async () => {
      try {
        await generateDraft(fd);
        setJustStarted(true);
        setTimeout(() => setJustStarted(false), 8000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to start draft");
      }
    });
  }

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>RFI Drafts</h1>
          <div className="sub">
            {drafts.length === 0 ? "No drafts yet." : `${drafts.length} draft${drafts.length !== 1 ? "s" : ""}`}
          </div>
        </div>
      </div>

      <p className="sub" style={{ marginBottom: 16, maxWidth: 760 }}>
        Cleo drafts Sources Sought / RFI responses grounded in Lumiture&apos;s profile and past performance.
        Pick an opportunity and generate. Drafting runs in the background (~20–40s), then the draft appears
        below. Review, copy, and finish it before submitting.
      </p>

      <form onSubmit={handleGenerate} className="card" style={{ padding: 16, marginBottom: 20, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field" style={{ margin: 0, flex: "1 1 420px" }}>
          <label>Opportunity</label>
          <select className="input" name="samNoticeId" value={selected} onChange={(e) => setSelected(e.target.value)} required>
            <option value="">Select an opportunity…</option>
            {opportunities.map((o) => (
              <option key={o.sam_notice_id} value={o.sam_notice_id}>
                {(o.notice_type ? `[${o.notice_type}] ` : "") + (o.title ?? o.sam_notice_id)}
                {o.response_deadline ? ` (due ${o.response_deadline.slice(0, 10)})` : ""}
              </option>
            ))}
          </select>
          <span className="hint">SAM opportunities (Sources Sought / RFIs are the usual targets).</span>
        </div>
        <button type="submit" className="btn accent" disabled={genPending || !selected}>
          {genPending
            ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Starting…</>
            : <><Sparkles style={{ width: 13, height: 13 }} /> Generate draft</>}
        </button>
      </form>

      {error && <div className="card" style={{ padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "var(--err)" }}>{error}</div>}
      {justStarted && (
        <div className="card" style={{ padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "var(--ink-2)" }}>
          ✨ Draft started. It runs in the background; refresh in ~30 seconds and it&apos;ll appear below.
        </div>
      )}

      {drafts.length === 0 ? (
        <div className="empty">
          <div className="ico"><FileText /></div>
          <h4>No RFI drafts yet.</h4>
          <p>Pick an opportunity above and generate your first Sources Sought / RFI response.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {drafts.map((d) => <DraftCard key={d.id} draft={d} deleteDraft={deleteDraft} submitAnswers={submitAnswers} />)}
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function DraftCard({ draft, deleteDraft, submitAnswers }: { draft: RfiDraft; deleteDraft: Props["deleteDraft"]; submitAnswers: Props["submitAnswers"] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [delPending, startDel] = useTransition();

  function copy() {
    navigator.clipboard.writeText(draft.draft_markdown ?? "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown style={{ width: 15, height: 15, color: "var(--ink-3)" }} /> : <ChevronRight style={{ width: 15, height: 15, color: "var(--ink-3)" }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {draft.opportunity_title ?? "Untitled opportunity"}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {draft.status === "intake" ? (
              <span className="chip" style={{ color: "var(--warn)", borderColor: "var(--warn-line)", fontSize: 11 }}>
                <ClipboardList style={{ width: 11, height: 11, verticalAlign: "-1px" }} /> needs answers
              </span>
            ) : (
              <span className="chip" style={{ color: "var(--ok)", borderColor: "var(--ok-line)", fontSize: 11 }}>ready</span>
            )}
            {draft.assessment && draft.assessment.mustFix.length > 0 && (
              <span className="chip" style={{ fontSize: 11 }}>{draft.assessment.mustFix.length} fixes applied</span>
            )}
            <span>{[draft.notice_type, draft.agency, timeAgo(draft.created_at)].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <button className="btn ghost sm" onClick={copy} title="Copy draft">
            {copied ? <Check style={{ width: 13, height: 13, color: "var(--ok, #16a34a)" }} /> : <Copy style={{ width: 13, height: 13 }} />}
          </button>
          <form action={(fd) => startDel(async () => { await deleteDraft(fd); })} style={{ display: "inline" }}>
            <input type="hidden" name="id" value={draft.id} />
            <button type="submit" className="btn ghost sm" disabled={delPending} title="Delete draft">
              {delPending ? <Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> : <Trash2 style={{ width: 13, height: 13 }} />}
            </button>
          </form>
        </div>
      </div>
      {open && (
        <div style={{ borderTop: "1px solid var(--line)", padding: 16, background: "var(--bg-2)" }}>
          {draft.status === "intake"
            ? <IntakeGate draft={draft} submitAnswers={submitAnswers} />
            : (
              <>
                {draft.assessment && <AssessmentPanel assessment={draft.assessment} />}
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: 13, lineHeight: 1.55, color: "var(--ink-1)", maxHeight: 480, overflowY: "auto" }}>
                  {draft.draft_markdown}
                </pre>
              </>
            )}
        </div>
      )}
    </div>
  );
}

// The intake gate: the analysis found material gaps, so we collect confirmed answers
// before drafting rather than letting the model guess on a federal submission.
function IntakeGate({ draft, submitAnswers }: { draft: RfiDraft; submitAnswers: Props["submitAnswers"] }) {
  const intake = draft.intake;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  if (!intake) return <div className="sub">No intake recorded for this draft.</div>;

  const answered = Object.values(answers).filter((v) => v && v.trim()).length;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("draftId", draft.id);
    fd.set("samNoticeId", draft.sam_notice_id ?? "");
    fd.set("answers", JSON.stringify(answers));
    setErr(null);
    start(async () => {
      try { await submitAnswers(fd); }
      catch (e2) { setErr(e2 instanceof Error ? e2.message : "Failed to start draft"); }
    });
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
        <b>Not drafted yet.</b> {intake.sufficiencyReason}
      </div>

      {intake.risks.length > 0 && (
        <div style={{ display: "grid", gap: 5 }}>
          {intake.risks.map((r, i) => (
            <div key={i} style={{ fontSize: 12.5, color: "var(--ink-1)", display: "flex", gap: 7 }}>
              <AlertTriangle style={{ width: 13, height: 13, color: "var(--warn)", flexShrink: 0, marginTop: 2 }} />
              <span><b style={{ textTransform: "capitalize" }}>{r.kind.replace(/-/g, " ")}:</b> {r.detail}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {intake.questions.map((q, i) => (
          <div key={i} className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 12.5 }}>
              {q.mustAnswer && <span style={{ color: "var(--err)", marginRight: 4 }} title="Blocks an accurate draft">*</span>}
              {q.question}
            </label>
            <textarea
              className="input" rows={2} placeholder="Your answer…"
              value={answers[q.question] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.question]: e.target.value }))}
            />
            <span className="hint">{q.why}</span>
          </div>
        ))}
      </div>

      {intake.matrix.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>Experience fit matrix ({intake.matrix.length})</summary>
          <table className="tbl" style={{ width: "100%", marginTop: 8, fontSize: 12 }}>
            <thead><tr><th>Engagement</th><th>Requirement</th><th>Fit</th><th>How</th></tr></thead>
            <tbody>
              {intake.matrix.map((m, i) => (
                <tr key={i}>
                  <td>{m.engagement}</td><td>{m.requirement}</td>
                  <td><span className="chip" style={{ fontSize: 11 }}>{m.strength}</span></td>
                  <td style={{ color: "var(--ink-2)" }}>{m.how}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {err && <div style={{ fontSize: 12.5, color: "var(--err)" }}>{err}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button type="submit" className="btn accent sm" disabled={pending || answered === 0}>
          {pending ? <Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> : <Sparkles style={{ width: 13, height: 13 }} />}
          Draft with these answers
        </button>
        <span className="sub">{answered} of {intake.questions.length} answered</span>
      </div>
    </form>
  );
}

// What the evaluator pass found, surfaced so a human makes the final call.
function AssessmentPanel({ assessment }: { assessment: NonNullable<RfiDraft["assessment"]> }) {
  const failed = assessment.compliance.filter((c) => !c.pass);
  return (
    <div className="card" style={{ padding: 12, marginBottom: 14, background: "var(--bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>
        <ShieldCheck style={{ width: 14, height: 14 }} /> Evaluator assessment
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, marginBottom: 8 }}>
        <span>Compliance: <b style={{ color: failed.length ? "var(--err)" : "var(--ok)" }}>{failed.length ? `${failed.length} failing` : "pass"}</b></span>
        {assessment.factors.map((f, i) => (
          <span key={i}>{f.factor}: <b style={{ color: RATING_COLOR[f.rating] ?? "var(--ink-2)" }}>{f.rating}</b></span>
        ))}
      </div>

      {assessment.mustFix.length > 0 && (
        <div style={{ fontSize: 12.5, marginBottom: 6 }}>
          <b>Fixed before you saw it:</b>
          <ul style={{ margin: "4px 0 0 18px", color: "var(--ink-2)" }}>
            {assessment.mustFix.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        </div>
      )}
      {assessment.wouldStrengthen.length > 0 && (
        <div style={{ fontSize: 12.5 }}>
          <b>Would strengthen (needs your input):</b>
          <ul style={{ margin: "4px 0 0 18px", color: "var(--ink-2)" }}>
            {assessment.wouldStrengthen.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
