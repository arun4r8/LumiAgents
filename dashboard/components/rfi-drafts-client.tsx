"use client";

import { useState, useTransition } from "react";
import { FileText, Sparkles, Loader2, Trash2, Copy, Check, ChevronRight, ChevronDown } from "lucide-react";
import type { RfiDraft, OppOption } from "@/app/(dashboard)/rfi-drafts/page";

interface Props {
  drafts: RfiDraft[];
  opportunities: OppOption[];
  generateDraft: (formData: FormData) => Promise<void>;
  deleteDraft: (formData: FormData) => Promise<void>;
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function RfiDraftsClient({ drafts, opportunities, generateDraft, deleteDraft }: Props) {
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
        Pick an opportunity and generate — drafting runs in the background (~20–40s), then the draft appears
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
                {o.response_deadline ? ` — due ${o.response_deadline.slice(0, 10)}` : ""}
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
          ✨ Draft started — it runs in the background. Refresh in ~30 seconds and it&apos;ll appear below.
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
          {drafts.map((d) => <DraftCard key={d.id} draft={d} deleteDraft={deleteDraft} />)}
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function DraftCard({ draft, deleteDraft }: { draft: RfiDraft; deleteDraft: Props["deleteDraft"] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [delPending, startDel] = useTransition();

  function copy() {
    navigator.clipboard.writeText(draft.draft_markdown).then(() => {
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
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
            {[draft.notice_type, draft.agency, `drafted ${timeAgo(draft.created_at)}`].filter(Boolean).join(" · ")}
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
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: 13, lineHeight: 1.55, color: "var(--ink-1)", maxHeight: 480, overflowY: "auto" }}>
            {draft.draft_markdown}
          </pre>
        </div>
      )}
    </div>
  );
}
