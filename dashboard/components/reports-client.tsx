"use client";

import { useTransition, useRef, useState } from "react";
import { Mail, Plus, Trash2, Power, PowerOff, Loader2, X, Pencil, Check } from "lucide-react";

interface Subscription {
  id: string;
  label: string | null;
  cadence: "daily" | "weekly";
  recipients: string[];
  min_fit_score: number;
  is_active: boolean;
  last_sent_at: string | null;
  created_at: string;
}

interface Props {
  subscriptions: Subscription[];
  emailConfigured: boolean;
  createSubscription: (formData: FormData) => Promise<void>;
  toggleSubscription: (formData: FormData) => Promise<void>;
  deleteSubscription: (formData: FormData) => Promise<void>;
  updateSubscription: (formData: FormData) => Promise<void>;
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

export function ReportsClient({
  subscriptions,
  emailConfigured,
  createSubscription,
  toggleSubscription,
  deleteSubscription,
  updateSubscription,
}: Props) {
  const [showCreate, setShowCreate] = useState(false);

  const active = subscriptions.filter((s) => s.is_active).length;

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Reports</h1>
          <div className="sub">
            {subscriptions.length === 0
              ? "No email reports configured yet."
              : `${subscriptions.length} report${subscriptions.length !== 1 ? "s" : ""} · ${active} active`}
          </div>
        </div>
        <button className="btn accent" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? <X style={{ width: 13, height: 13 }} /> : <Plus style={{ width: 13, height: 13 }} />}
          {showCreate ? "Cancel" : "New Report"}
        </button>
      </div>

      {!emailConfigured && (
        <div
          className="card"
          style={{ padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "var(--ink-2)", borderColor: "var(--warn, #b45309)" }}
        >
          ⚠ Email delivery is not configured yet. Reports you create here will be saved and
          scheduled, but no email is sent until <span className="mono">RESEND_API_KEY</span> and a
          verified sending domain are set on the runtime.
        </div>
      )}

      <p className="sub" style={{ marginBottom: 16, maxWidth: 720 }}>
        Beady emails the latest <strong>pursue-rated</strong> opportunities (fit score at or above
        your threshold) to the recipients below. A daily driver runs at 13:00 UTC; daily reports
        send every run, weekly reports send once every 7 days. Only opportunities scored since the
        last send are included.
      </p>

      {showCreate && (
        <CreateForm createSubscription={createSubscription} onCreated={() => setShowCreate(false)} />
      )}

      {subscriptions.length === 0 && !showCreate ? (
        <div className="empty">
          <div className="ico"><Mail /></div>
          <h4>No reports yet.</h4>
          <p>Create a report to have Beady email new pursue-rated opportunities on a cadence.</p>
        </div>
      ) : subscriptions.length > 0 ? (
        <div className="card" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)" }}>
                {["Report", "Recipients", "Cadence", "Min fit", "Last sent", "Status", ""].map((h) => (
                  <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-3)", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <SubscriptionRow
                  key={s.id}
                  subscription={s}
                  toggleSubscription={toggleSubscription}
                  deleteSubscription={deleteSubscription}
                  updateSubscription={updateSubscription}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function CreateForm({
  createSubscription,
  onCreated,
}: {
  createSubscription: (fd: FormData) => Promise<void>;
  onCreated: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      try {
        await createSubscription(fd);
        formRef.current?.reset();
        onCreated();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create report");
      }
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="card" style={{ padding: 20, marginBottom: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <div className="field" style={{ gridColumn: "1 / -1" }}>
        <label>Recipients</label>
        <input
          className="input"
          name="recipients"
          placeholder="alice@lumiture.com, bob@lumiture.com"
          required
        />
        <span className="hint">Comma-separated email addresses.</span>
      </div>
      <div className="field">
        <label>Cadence</label>
        <select className="input" name="cadence" defaultValue="weekly">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
        <span className="hint">How often to send (daily driver honors this).</span>
      </div>
      <div className="field">
        <label>Minimum fit score</label>
        <input
          className="input mono"
          name="min_fit_score"
          type="number"
          min={1}
          max={10}
          defaultValue={7}
          required
        />
        <span className="hint">Only include opportunities at or above this (1–10).</span>
      </div>
      <div className="field">
        <label>Label <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>(optional)</span></label>
        <input
          className="input"
          name="label"
          placeholder="e.g. Leadership weekly digest"
        />
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        {error && (
          <span style={{ fontSize: 12.5, color: "var(--err)", flex: 1 }}>{error}</span>
        )}
        <button type="submit" className="btn accent" disabled={pending} style={{ marginLeft: "auto" }}>
          {pending
            ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Creating…</>
            : <><Plus style={{ width: 13, height: 13 }} /> Create</>}
        </button>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </form>
  );
}

function SubscriptionRow({
  subscription: s,
  toggleSubscription,
  deleteSubscription,
  updateSubscription,
}: {
  subscription: Subscription;
  toggleSubscription: (fd: FormData) => Promise<void>;
  deleteSubscription: (fd: FormData) => Promise<void>;
  updateSubscription: (fd: FormData) => Promise<void>;
}) {
  const [togglePending, startToggle] = useTransition();
  const [deletePending, startDelete] = useTransition();
  const [editPending, startEdit] = useTransition();
  const [editing, setEditing] = useState(false);

  function handleEditSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startEdit(async () => {
      await updateSubscription(fd);
      setEditing(false);
    });
  }

  if (editing) {
    return (
      <tr style={{ borderBottom: "1px solid var(--line)", background: "var(--bg-2)" }}>
        <td colSpan={7} style={{ padding: "12px 16px" }}>
          <form onSubmit={handleEditSubmit} style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
            <input type="hidden" name="id" value={s.id} />
            <div className="field" style={{ margin: 0, flex: "2 1 240px" }}>
              <label style={{ fontSize: 11 }}>Recipients</label>
              <input className="input" name="recipients" defaultValue={s.recipients.join(", ")} required style={{ height: 30, fontSize: 13 }} />
            </div>
            <div className="field" style={{ margin: 0, flex: "1 1 120px" }}>
              <label style={{ fontSize: 11 }}>Cadence</label>
              <select className="input" name="cadence" defaultValue={s.cadence} style={{ height: 30, fontSize: 13 }}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <div className="field" style={{ margin: 0, flex: "0 1 90px" }}>
              <label style={{ fontSize: 11 }}>Min fit</label>
              <input className="input mono" name="min_fit_score" type="number" min={1} max={10} defaultValue={s.min_fit_score} required style={{ height: 30, fontSize: 13 }} />
            </div>
            <div className="field" style={{ margin: 0, flex: "1 1 140px" }}>
              <label style={{ fontSize: 11 }}>Label</label>
              <input className="input" name="label" defaultValue={s.label ?? ""} placeholder="Optional" style={{ height: 30, fontSize: 13 }} />
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "flex-end", paddingBottom: 2 }}>
              <button type="submit" className="btn accent sm" disabled={editPending}>
                {editPending
                  ? <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} />
                  : <Check style={{ width: 12, height: 12 }} />}
                {editPending ? "Saving…" : "Save"}
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setEditing(false)}>
                <X style={{ width: 12, height: 12 }} /> Cancel
              </button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr style={{ borderBottom: "1px solid var(--line)" }}>
      <td style={{ padding: "12px 16px" }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)" }}>
          {s.label ?? <span style={{ color: "var(--ink-3)" }}>—</span>}
        </div>
      </td>
      <td style={{ padding: "12px 16px" }}>
        <span style={{ fontSize: 12.5, color: "var(--ink-1)" }}>
          {s.recipients.length === 1 ? s.recipients[0] : `${s.recipients.length} recipients`}
        </span>
      </td>
      <td style={{ padding: "12px 16px" }}>
        <span className="chip" style={{ fontSize: 12, textTransform: "capitalize" }}>{s.cadence}</span>
      </td>
      <td style={{ padding: "12px 16px" }}>
        <span className="mono" style={{ fontSize: 12.5, color: "var(--ink-1)" }}>{s.min_fit_score}</span>
      </td>
      <td style={{ padding: "12px 16px" }}>
        <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
          {s.last_sent_at ? timeAgo(s.last_sent_at) : <span style={{ color: "var(--ink-3)" }}>Never</span>}
        </span>
      </td>
      <td style={{ padding: "12px 16px" }}>
        <span className={`chip ${s.is_active ? "ok" : ""}`} style={{ fontSize: 12 }}>
          {s.is_active ? "Active" : "Paused"}
        </span>
      </td>
      <td style={{ padding: "12px 16px", textAlign: "right", whiteSpace: "nowrap" }}>
        <button className="btn ghost sm" onClick={() => setEditing(true)} title="Edit">
          <Pencil style={{ width: 13, height: 13 }} />
        </button>
        <form
          style={{ display: "inline" }}
          action={(fd) => startToggle(async () => { await toggleSubscription(fd); })}
        >
          <input type="hidden" name="id" value={s.id} />
          <input type="hidden" name="is_active" value={String(s.is_active)} />
          <button type="submit" className="btn ghost sm" disabled={togglePending} title={s.is_active ? "Pause" : "Activate"}>
            {togglePending
              ? <Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} />
              : s.is_active
                ? <PowerOff style={{ width: 13, height: 13 }} />
                : <Power style={{ width: 13, height: 13 }} />}
          </button>
        </form>
        <form
          style={{ display: "inline" }}
          action={(fd) => startDelete(async () => { await deleteSubscription(fd); })}
        >
          <input type="hidden" name="id" value={s.id} />
          <button type="submit" className="btn ghost sm" disabled={deletePending} title="Delete">
            {deletePending
              ? <Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} />
              : <Trash2 style={{ width: 13, height: 13 }} />}
          </button>
        </form>
      </td>
    </tr>
  );
}
