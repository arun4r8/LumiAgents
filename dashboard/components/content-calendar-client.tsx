"use client";

import { Fragment, useRef, useState, useTransition } from "react";
import { CalendarDays, Sparkles, Loader2, Trash2, Copy, Check, ChevronDown, ChevronRight, Plus, Wand2, Pencil, Upload, RefreshCw } from "lucide-react";
import type { CalendarEntry } from "@/app/(dashboard)/records/content/page";

interface Props {
  entries: CalendarEntry[];
  createEntry: (formData: FormData) => Promise<void>;
  updateEntry: (formData: FormData) => Promise<void>;
  setStatus: (formData: FormData) => Promise<void>;
  deleteEntry: (formData: FormData) => Promise<void>;
  draftWithCleo: (formData: FormData) => Promise<void>;
  planWithCleo: (formData: FormData) => Promise<void>;
  importCsv: (formData: FormData) => Promise<{ imported: number; skipped: number }>;
  syncNow: () => Promise<{ started: boolean }>;
}

const STATUSES = ["idea", "drafting", "ready", "scheduled", "posted"] as const;
const STATUS_COLOR: Record<string, string> = {
  idea: "oklch(62% 0.02 260)",
  drafting: "oklch(65% 0.15 85)",
  ready: "oklch(60% 0.16 250)",
  scheduled: "oklch(60% 0.15 300)",
  posted: "oklch(58% 0.16 145)",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="chip" style={{ color: STATUS_COLOR[status] ?? "var(--ink-2)", borderColor: STATUS_COLOR[status] ?? "var(--line)" }}>
      {status}
    </span>
  );
}

export function ContentCalendarClient({
  entries, createEntry, updateEntry, setStatus, deleteEntry, draftWithCleo, planWithCleo, importCsv, syncNow,
}: Props) {
  const [showAdd, setShowAdd] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    setError(null); setImportMsg(null);
    startTransition(async () => {
      try {
        const r = await importCsv(fd);
        setImportMsg(`Imported ${r.imported} row${r.imported === 1 ? "" : "s"}${r.skipped ? ` · ${r.skipped} skipped (no topic)` : ""}.`);
        setTimeout(() => setImportMsg(null), 8000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed");
      } finally {
        if (fileRef.current) fileRef.current.value = "";
      }
    });
  }

  function handleSync() {
    setError(null); setImportMsg(null);
    startTransition(async () => {
      try {
        await syncNow();
        setImportMsg("Live sync started from the M365 planning workbook. Synced rows appear here shortly — refresh to see them.");
        setTimeout(() => setImportMsg(null), 8000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sync failed");
      }
    });
  }

  function run(fd: FormData, action: (f: FormData) => Promise<void>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      try { await action(fd); after?.(); }
      catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
    });
  }

  function copyDraft(id: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  const counts = STATUSES.map((s) => ({ s, n: entries.filter((e) => e.status === s).length }));

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1><CalendarDays size={20} style={{ verticalAlign: "-3px", marginRight: 8 }} />Content Calendar</h1>
          <div className="sub">
            {entries.length === 0 ? "No entries yet." : `${entries.length} entr${entries.length === 1 ? "y" : "ies"} · ` +
              counts.filter((c) => c.n > 0).map((c) => `${c.n} ${c.s}`).join(" · ")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleImport} style={{ display: "none" }} />
          <button className="btn sm" onClick={handleSync} disabled={pending} title="Live-sync from the Microsoft 365 planning workbook (Graph API)">
            {pending ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Sync now
          </button>
          <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={pending} title="Import from a spreadsheet CSV export">
            {pending ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} Import CSV
          </button>
          <button className="btn sm" onClick={() => { setShowPlan((v) => !v); setShowAdd(false); }}>
            <Wand2 size={14} /> Plan with Cleo
          </button>
          <button className="btn accent sm" onClick={() => { setShowAdd((v) => !v); setShowPlan(false); }}>
            <Plus size={14} /> Add entry
          </button>
        </div>
      </div>

      <p className="sub" style={{ marginBottom: 16, maxWidth: 780 }}>
        The eminence plan as a living calendar. Add posts, or have Cleo propose a run of ideas from a theme.
        Cleo drafts the post copy + asset brief for any entry (grounded in the company profile), and the draft lands
        here with status <b>ready</b>. A human always reviews before posting; nothing publishes automatically.
        <b>Sync now</b> live-pulls the team's Microsoft 365 planning workbook via the Graph API; rows sync in and
        re-syncing an edited sheet updates them without touching existing drafts. <b>Import CSV</b> stays as a manual
        fallback (export the sheet to CSV first) — both paths key on the same rows, so they stay interchangeable.
      </p>

      {importMsg && <div className="chip ok" style={{ marginBottom: 12 }}>{importMsg}</div>}
      {error && <div className="chip" style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</div>}

      {showPlan && (
        <form
          className="card"
          style={{ padding: 16, marginBottom: 16, display: "grid", gap: 10 }}
          onSubmit={(e) => { e.preventDefault(); run(new FormData(e.currentTarget), planWithCleo, () => setShowPlan(false)); }}
        >
          <div style={{ fontWeight: 600 }}>Plan a content run with Cleo</div>
          <input className="in" name="theme" placeholder="Theme, e.g. 'AI in government contracting'" required />
          <div style={{ display: "flex", gap: 10 }}>
            <input className="in" name="count" type="number" min={1} max={20} defaultValue={5} style={{ width: 120 }} placeholder="# ideas" />
            <input className="in" name="startDate" type="date" style={{ width: 180 }} />
            <button className="btn accent sm" type="submit" disabled={pending}>
              {pending ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Generate ideas
            </button>
          </div>
          <div className="sub">Runs in the background (~15–30s), then idea rows appear below (weekly cadence). Refresh to see them.</div>
        </form>
      )}

      {showAdd && (
        <form
          className="card"
          style={{ padding: 16, marginBottom: 16, display: "grid", gap: 10 }}
          onSubmit={(e) => { e.preventDefault(); run(new FormData(e.currentTarget), createEntry, () => setShowAdd(false)); }}
        >
          <div style={{ fontWeight: 600 }}>Add calendar entry</div>
          <input className="in" name="topic" placeholder="Topic *" required />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input className="in" name="release_date" type="date" style={{ width: 180 }} />
            <input className="in" name="channel" placeholder="Channel (linkedin)" defaultValue="linkedin" style={{ width: 160 }} />
            <input className="in" name="asset_type" placeholder="Asset type (graphic)" style={{ width: 160 }} />
            <input className="in" name="owner" placeholder="Owner" style={{ width: 140 }} />
          </div>
          <input className="in" name="asset_ref" placeholder="Asset ref (filename / URL)" />
          <textarea className="in" name="description" placeholder="Description / brief (Cleo grounds the draft on this)" rows={2} />
          <button className="btn accent sm" type="submit" disabled={pending} style={{ justifySelf: "start" }}>
            {pending ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Add
          </button>
        </form>
      )}

      {entries.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div className="sub">Nothing scheduled yet. Add an entry or plan a run with Cleo to get started.</div>
        </div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ width: "100%", minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ width: 130 }}>Release</th>
                <th>Topic</th>
                <th style={{ width: 110 }}>Channel</th>
                <th style={{ width: 130 }}>Asset</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 260 }}></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <Fragment key={e.id}>
                  <tr>
                    <td>{fmtDate(e.release_date)}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{e.topic}</div>
                      {e.description && <div className="sub" style={{ maxWidth: 380 }}>{e.description}</div>}
                    </td>
                    <td>{e.channel}</td>
                    <td className="sub">{e.asset_type ?? "-"}{e.asset_ref ? ` · ${e.asset_ref}` : ""}</td>
                    <td><StatusBadge status={e.status} /></td>
                    <td>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {e.draft_markdown && (
                          <button className="btn sm" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                            {expanded === e.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Draft
                          </button>
                        )}
                        {(e.status === "idea" || e.status === "drafting") && (
                          <form action={draftWithCleo} style={{ display: "inline" }}>
                            <input type="hidden" name="id" value={e.id} />
                            <button className="btn accent sm" type="submit" disabled={pending}>
                              <Sparkles size={13} /> {e.draft_markdown ? "Redraft" : "Draft"}
                            </button>
                          </form>
                        )}
                        <form action={setStatus} style={{ display: "inline" }}>
                          <input type="hidden" name="id" value={e.id} />
                          <select name="status" defaultValue={e.status} className="in" style={{ padding: "3px 6px", height: 28 }}
                            onChange={(ev) => run(new FormData(ev.currentTarget.form!), setStatus)}>
                            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </form>
                        <button className="btn sm" onClick={() => setEditing(editing === e.id ? null : e.id)}><Pencil size={13} /></button>
                        <form action={deleteEntry} style={{ display: "inline" }}>
                          <input type="hidden" name="id" value={e.id} />
                          <button className="btn sm danger" type="submit" title="Delete"><Trash2 size={13} /></button>
                        </form>
                      </div>
                    </td>
                  </tr>

                  {editing === e.id && (
                    <tr key={e.id + "-edit"}>
                      <td colSpan={6} style={{ background: "var(--bg-2)" }}>
                        <form
                          style={{ display: "grid", gap: 8, padding: 12 }}
                          onSubmit={(ev) => { ev.preventDefault(); run(new FormData(ev.currentTarget), updateEntry, () => setEditing(null)); }}
                        >
                          <input type="hidden" name="id" value={e.id} />
                          <input className="in" name="topic" defaultValue={e.topic} placeholder="Topic" />
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <input className="in" name="release_date" type="date" defaultValue={e.release_date ?? ""} style={{ width: 180 }} />
                            <input className="in" name="channel" defaultValue={e.channel} style={{ width: 150 }} />
                            <input className="in" name="asset_type" defaultValue={e.asset_type ?? ""} placeholder="Asset type" style={{ width: 150 }} />
                            <input className="in" name="owner" defaultValue={e.owner ?? ""} placeholder="Owner" style={{ width: 130 }} />
                          </div>
                          <input className="in" name="asset_ref" defaultValue={e.asset_ref ?? ""} placeholder="Asset ref" />
                          <textarea className="in" name="description" defaultValue={e.description ?? ""} rows={2} placeholder="Description / brief" />
                          <div style={{ display: "flex", gap: 8 }}>
                            <button className="btn accent sm" type="submit" disabled={pending}><Check size={13} /> Save</button>
                            <button className="btn sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
                          </div>
                        </form>
                      </td>
                    </tr>
                  )}

                  {expanded === e.id && e.draft_markdown && (
                    <tr key={e.id + "-draft"}>
                      <td colSpan={6} style={{ background: "var(--bg-2)" }}>
                        <div style={{ padding: 12 }}>
                          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
                            <button className="btn sm" onClick={() => copyDraft(e.id, e.draft_markdown!)}>
                              {copied === e.id ? <Check size={13} /> : <Copy size={13} />} {copied === e.id ? "Copied" : "Copy"}
                            </button>
                          </div>
                          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
                            {e.draft_markdown}
                          </pre>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
