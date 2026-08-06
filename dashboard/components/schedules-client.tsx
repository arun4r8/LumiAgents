"use client";

import { useTransition, useRef, useState } from "react";
import { Clock, Plus, Trash2, Power, PowerOff, Loader2, X, Pencil, Check } from "lucide-react";

interface Schedule {
  id: string;
  orchestration_name: string;
  label: string | null;
  cron_expression: string;
  is_active: boolean;
  last_run_at: string | null;
  created_at: string;
}

interface Props {
  schedules: Schedule[];
  createSchedule: (formData: FormData) => Promise<void>;
  toggleSchedule: (formData: FormData) => Promise<void>;
  deleteSchedule: (formData: FormData) => Promise<void>;
  updateSchedule: (formData: FormData) => Promise<void>;
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

export function SchedulesClient({ schedules, createSchedule, toggleSchedule, deleteSchedule, updateSchedule }: Props) {
  const [showCreate, setShowCreate] = useState(false);

  const active = schedules.filter((s) => s.is_active).length;

  return (
    <div className="page view-fade" style={{ maxWidth: 980 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, marginBottom: 26 }}>
        <div>
          <h1 className="p6-h1">Schedules</h1>
          <div className="p6-sub" style={{ margin: 0 }}>
            {schedules.length === 0
              ? "No scheduled orchestrations yet — all times UTC."
              : `${schedules.length} cron trigger${schedules.length !== 1 ? "s" : ""} · ${active} active · all times UTC`}
          </div>
        </div>
        <button className="btn primary" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? <X style={{ width: 13, height: 13 }} /> : <Plus style={{ width: 13, height: 13 }} />}
          {showCreate ? "Cancel" : "New Schedule"}
        </button>
      </div>

      {showCreate && (
        <CreateForm createSchedule={createSchedule} onCreated={() => setShowCreate(false)} />
      )}

      {schedules.length === 0 && !showCreate ? (
        <div className="empty">
          <div className="ico"><Clock /></div>
          <h4>No schedules yet.</h4>
          <p>Create a schedule to run an orchestration on a recurring cron cadence.</p>
        </div>
      ) : schedules.length > 0 ? (
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="tbl">
            <thead>
              <tr>
                {["Schedule", "Orchestration", "Cron", "Last run", "Status", ""].map((h, i) => (
                  <th key={h || i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <ScheduleRow key={s.id} schedule={s} toggleSchedule={toggleSchedule} deleteSchedule={deleteSchedule} updateSchedule={updateSchedule} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function CreateForm({
  createSchedule,
  onCreated,
}: {
  createSchedule: (fd: FormData) => Promise<void>;
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
        await createSchedule(fd);
        formRef.current?.reset();
        onCreated();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create schedule");
      }
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="card" style={{ padding: 20, marginBottom: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <div className="field">
        <label>Orchestration name</label>
        <input
          className="input"
          name="orchestration_name"
          placeholder="e.g. beady/opportunity-sweep"
          required
        />
        <span className="hint">Must exist in the runtime registry.</span>
      </div>
      <div className="field">
        <label>Cron expression</label>
        <input
          className="input mono"
          name="cron_expression"
          placeholder="e.g. 0 8 * * 1"
          required
        />
        <span className="hint">5-field UTC cron (min hr dom mon dow).</span>
      </div>
      <div className="field">
        <label>Label <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>(optional)</span></label>
        <input
          className="input"
          name="label"
          placeholder="e.g. Weekly opportunity scan"
        />
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        {error && (
          <span style={{ fontSize: 12.5, color: "var(--err)", flex: 1 }}>{error}</span>
        )}
        <button type="submit" className="btn primary" disabled={pending} style={{ marginLeft: "auto" }}>
          {pending
            ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Creating…</>
            : <><Plus style={{ width: 13, height: 13 }} /> Create</>}
        </button>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </form>
  );
}

function ScheduleRow({
  schedule: s,
  toggleSchedule,
  deleteSchedule,
  updateSchedule,
}: {
  schedule: Schedule;
  toggleSchedule: (fd: FormData) => Promise<void>;
  deleteSchedule: (fd: FormData) => Promise<void>;
  updateSchedule: (fd: FormData) => Promise<void>;
}) {
  const [togglePending, startToggle] = useTransition();
  const [deletePending, startDelete] = useTransition();
  const [editPending, startEdit] = useTransition();
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState(s.label ?? "");
  const [editCron, setEditCron] = useState(s.cron_expression);

  function openEdit() {
    setEditLabel(s.label ?? "");
    setEditCron(s.cron_expression);
    setEditing(true);
  }

  function handleEditSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startEdit(async () => {
      await updateSchedule(fd);
      setEditing(false);
    });
  }

  if (editing) {
    return (
      <tr style={{ borderBottom: "1px solid var(--line)", background: "var(--bg-2)" }}>
        <td colSpan={6} style={{ padding: "12px 16px" }}>
          <form onSubmit={handleEditSubmit} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <input type="hidden" name="id" value={s.id} />
            <div className="field" style={{ margin: 0, flex: "1 1 160px" }}>
              <label style={{ fontSize: 11 }}>Label</label>
              <input
                className="input"
                name="label"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                placeholder="Optional label"
                style={{ height: 30, fontSize: 13 }}
              />
            </div>
            <div className="field" style={{ margin: 0, flex: "1 1 160px" }}>
              <label style={{ fontSize: 11 }}>Cron expression</label>
              <input
                className="input mono"
                name="cron_expression"
                value={editCron}
                onChange={(e) => setEditCron(e.target.value)}
                required
                style={{ height: 30, fontSize: 13 }}
              />
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "flex-end", paddingBottom: 2 }}>
              <button type="submit" className="btn primary sm" disabled={editPending}>
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
    <tr style={{ cursor: "default" }}>
      <td>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--color-text)" }}>
          {s.label ?? <span style={{ color: "var(--color-neutral-500)" }}>-</span>}
        </div>
      </td>
      <td>
        <span className="mono" style={{ fontSize: 12.5, color: "var(--color-neutral-200)" }}>{s.orchestration_name}</span>
      </td>
      <td>
        <span className="mono" style={{ fontSize: 12, color: "var(--color-neutral-300)" }}>{s.cron_expression}</span>
      </td>
      <td>
        <span className="mono" style={{ fontSize: 12, color: "var(--color-neutral-400)" }}>
          {s.last_run_at ? timeAgo(s.last_run_at) : "Never"}
        </span>
      </td>
      <td>
        <span className={`tag ${s.is_active ? "tag-accent" : "tag-outline"}`}>
          {s.is_active ? "active" : "paused"}
        </span>
      </td>
      <td>
        <div className="row gap-sm" style={{ justifyContent: "flex-end" }}>
          <button className="btn ghost sm" onClick={openEdit} title="Edit">
            <Pencil style={{ width: 13, height: 13 }} />
          </button>
          <form onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            startToggle(() => toggleSchedule(fd));
          }}>
            <input type="hidden" name="id" value={s.id} />
            <input type="hidden" name="is_active" value={String(s.is_active)} />
            <button type="submit" className="btn ghost sm" disabled={togglePending} title={s.is_active ? "Pause" : "Resume"}>
              {togglePending
                ? <Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} />
                : s.is_active
                  ? <PowerOff style={{ width: 13, height: 13 }} />
                  : <Power style={{ width: 13, height: 13 }} />}
            </button>
          </form>
          <form onSubmit={(e) => {
            e.preventDefault();
            if (!confirm(`Delete schedule "${s.label ?? s.orchestration_name}"?`)) return;
            const fd = new FormData(e.currentTarget);
            startDelete(() => deleteSchedule(fd));
          }}>
            <input type="hidden" name="id" value={s.id} />
            <button type="submit" className="btn ghost sm" disabled={deletePending} title="Delete" style={{ color: "var(--err)" }}>
              {deletePending
                ? <Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} />
                : <Trash2 style={{ width: 13, height: 13 }} />}
            </button>
          </form>
        </div>
      </td>
    </tr>
  );
}
