"use client";

import { useTransition, useRef, useState } from "react";
import { Clock, Plus, Trash2, Power, PowerOff, Loader2, X } from "lucide-react";

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

export function SchedulesClient({ schedules, createSchedule, toggleSchedule, deleteSchedule }: Props) {
  const [showCreate, setShowCreate] = useState(false);

  const active = schedules.filter((s) => s.is_active).length;

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Schedules</h1>
          <div className="sub">
            {schedules.length === 0
              ? "No scheduled orchestrations yet."
              : `${schedules.length} schedule${schedules.length !== 1 ? "s" : ""} · ${active} active`}
          </div>
        </div>
        <button className="btn accent" onClick={() => setShowCreate((v) => !v)}>
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
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)" }}>
                {["Schedule", "Orchestration", "Cron", "Last run", "Status", ""].map((h) => (
                  <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-3)", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <ScheduleRow key={s.id} schedule={s} toggleSchedule={toggleSchedule} deleteSchedule={deleteSchedule} />
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
          placeholder="e.g. beady/opportunity-search"
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

function ScheduleRow({
  schedule: s,
  toggleSchedule,
  deleteSchedule,
}: {
  schedule: Schedule;
  toggleSchedule: (fd: FormData) => Promise<void>;
  deleteSchedule: (fd: FormData) => Promise<void>;
}) {
  const [togglePending, startToggle] = useTransition();
  const [deletePending, startDelete] = useTransition();

  return (
    <tr style={{ borderBottom: "1px solid var(--line)" }}>
      <td style={{ padding: "12px 16px" }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)" }}>
          {s.label ?? <span style={{ color: "var(--ink-3)" }}>—</span>}
        </div>
      </td>
      <td style={{ padding: "12px 16px" }}>
        <span className="mono" style={{ fontSize: 12.5, color: "var(--ink-1)" }}>{s.orchestration_name}</span>
      </td>
      <td style={{ padding: "12px 16px" }}>
        <span className="mono chip" style={{ fontSize: 12 }}>{s.cron_expression}</span>
      </td>
      <td style={{ padding: "12px 16px" }}>
        <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
          {s.last_run_at ? timeAgo(s.last_run_at) : <span style={{ color: "var(--ink-3)" }}>Never</span>}
        </span>
      </td>
      <td style={{ padding: "12px 16px" }}>
        <span className={`chip ${s.is_active ? "ok" : ""}`} style={{ fontSize: 12 }}>
          {s.is_active ? "Active" : "Paused"}
        </span>
      </td>
      <td style={{ padding: "12px 16px" }}>
        <div className="row gap-sm" style={{ justifyContent: "flex-end" }}>
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
