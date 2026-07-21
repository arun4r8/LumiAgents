"use client";

import { useTransition, useRef, useState } from "react";
import { Mail, Trophy, Plus, Trash2, Power, PowerOff, Loader2, X, Pencil, Check, Send } from "lucide-react";

export interface Subscription {
  id: string;
  kind: "opportunity" | "award";
  label: string | null;
  cadence: "daily" | "weekly";
  recipients: string[];
  min_fit_score: number;
  is_active: boolean;
  last_sent_at: string | null;
  sources: string[] | null;
  agencies: string[] | null;
  set_asides: string[] | null;
  award_types: string[] | null;
}

type Kind = "opportunity" | "award";

export type SubscriptionKind = Kind;

interface Actions {
  createSubscription: (formData: FormData) => Promise<void>;
  toggleSubscription: (formData: FormData) => Promise<void>;
  deleteSubscription: (formData: FormData) => Promise<void>;
  updateSubscription: (formData: FormData) => Promise<void>;
  sendNow: (formData: FormData) => Promise<void>;
}

interface Props extends Actions {
  subscriptions: Subscription[];
  emailConfigured: boolean;
  /** When set, this surface manages only one kind (no tabs, create form fixed). */
  lockedKind?: Kind;
  /** Which tab opens first when tabs are shown. Ignored when lockedKind is set. */
  initialTab?: Kind | "all";
  title?: string;
  intro?: string;
  /** Render without the outer page chrome (for embedding in another page). */
  embedded?: boolean;
}

const SOURCE_OPTIONS = [
  { value: "sam_gov", label: "SAM.gov" },
  { value: "sbir", label: "SBIR/STTR" },
];

const KIND_LABEL: Record<Kind, string> = { opportunity: "Opportunity", award: "Award" };

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function filterChips(s: Subscription): string[] {
  const chips: string[] = [];
  if (s.kind === "award") {
    if (s.award_types?.length) chips.push(`types: ${s.award_types.join(", ")}`);
    return chips;
  }
  if (s.sources?.length) chips.push(s.sources.map((x) => SOURCE_OPTIONS.find((o) => o.value === x)?.label ?? x).join(" / "));
  if (s.agencies?.length) chips.push(`agency: ${s.agencies.join(", ")}`);
  if (s.set_asides?.length) chips.push(`set-aside: ${s.set_asides.join(", ")}`);
  return chips;
}

export function SubscriptionsClient(props: Props) {
  const { subscriptions, emailConfigured, lockedKind, initialTab, title, intro, embedded } = props;
  const [showCreate, setShowCreate] = useState(false);
  const [tab, setTab] = useState<Kind | "all">(lockedKind ?? initialTab ?? "all");

  const visible = subscriptions.filter((s) => (lockedKind ? s.kind === lockedKind : tab === "all" ? true : s.kind === tab));
  const active = visible.filter((s) => s.is_active).length;

  return (
    <div className={embedded ? "" : "page view-fade"}>
      <div className="page-h">
        <div>
          <h1>{title ?? "Subscriptions"}</h1>
          <div className="sub">
            {visible.length === 0
              ? "No email subscriptions configured yet."
              : `${visible.length} subscription${visible.length !== 1 ? "s" : ""} · ${active} active`}
          </div>
        </div>
        <button className="btn accent" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? <X style={{ width: 13, height: 13 }} /> : <Plus style={{ width: 13, height: 13 }} />}
          {showCreate ? "Cancel" : "New Subscription"}
        </button>
      </div>

      {!lockedKind && (
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {(["all", "opportunity", "award"] as const).map((t) => (
            <button
              key={t}
              className={`chip ${tab === t ? "ok" : ""}`}
              style={{ cursor: "pointer", textTransform: "capitalize", padding: "5px 12px" }}
              onClick={() => setTab(t)}
            >
              {t === "all" ? "All" : `${KIND_LABEL[t]} digests`}
            </button>
          ))}
        </div>
      )}

      {!emailConfigured && (
        <div className="card" style={{ padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "var(--ink-2)", borderColor: "var(--warn, #b45309)" }}>
          ⚠ Email delivery is not configured yet. Subscriptions are saved and scheduled, but no
          email is sent until <span className="mono">RESEND_API_KEY</span> and a verified sending
          domain are set on the runtime.
        </div>
      )}

      {intro && <p className="sub" style={{ marginBottom: 16, maxWidth: 760 }}>{intro}</p>}

      {showCreate && (
        <CreateForm
          createSubscription={props.createSubscription}
          onCreated={() => setShowCreate(false)}
          lockedKind={lockedKind}
        />
      )}

      {visible.length === 0 && !showCreate ? (
        <div className="empty">
          <div className="ico">{lockedKind === "award" ? <Trophy /> : <Mail />}</div>
          <h4>No subscriptions yet.</h4>
          <p>Create one to have digests emailed on a cadence.</p>
        </div>
      ) : visible.length > 0 ? (
        <div className="card" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)" }}>
                {[...(lockedKind ? [] : ["Kind"]), "Subscription", "Recipients", "Cadence", "Min fit", "Last sent", "Status", ""].map((h) => (
                  <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-3)", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <SubscriptionRow
                  key={s.id}
                  subscription={s}
                  showKind={!lockedKind}
                  toggleSubscription={props.toggleSubscription}
                  deleteSubscription={props.deleteSubscription}
                  updateSubscription={props.updateSubscription}
                  sendNow={props.sendNow}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// Kind-aware filter inputs for create + edit.
function FilterFields({ kind, s, compact }: { kind: Kind; s?: Subscription; compact?: boolean }) {
  const labelSize = compact ? 11 : undefined;
  const inputStyle = compact ? { height: 30, fontSize: 13 } : undefined;
  if (kind === "award") {
    return (
      <div className="field" style={{ gridColumn: compact ? undefined : "1 / -1" }}>
        <label style={{ fontSize: labelSize }}>Award types <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>(optional)</span></label>
        <input className="input" name="award_types" defaultValue={s?.award_types?.join(", ") ?? ""} placeholder="e.g. industry, government" style={inputStyle} />
        {!compact && <span className="hint">Comma-separated; leave blank to include all award types.</span>}
      </div>
    );
  }
  return (
    <>
      <div className="field" style={{ gridColumn: compact ? undefined : "1 / -1" }}>
        <label style={{ fontSize: labelSize }}>Sources <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>(optional)</span></label>
        <div style={{ display: "flex", gap: 16, alignItems: "center", height: compact ? 30 : undefined }}>
          {SOURCE_OPTIONS.map((o) => (
            <label key={o.value} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 400, cursor: "pointer" }}>
              <input type="checkbox" name="sources" value={o.value} defaultChecked={s?.sources?.includes(o.value) ?? false} />
              {o.label}
            </label>
          ))}
        </div>
        {!compact && <span className="hint">Leave both unchecked to include all sources.</span>}
      </div>
      <div className="field">
        <label style={{ fontSize: labelSize }}>Agencies <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>(optional)</span></label>
        <input className="input" name="agencies" defaultValue={s?.agencies?.join(", ") ?? ""} placeholder="e.g. Navy, DARPA" style={inputStyle} />
        {!compact && <span className="hint">Comma-separated; matches agency name (substring).</span>}
      </div>
      <div className="field">
        <label style={{ fontSize: labelSize }}>Set-asides <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>(optional)</span></label>
        <input className="input" name="set_asides" defaultValue={s?.set_asides?.join(", ") ?? ""} placeholder="e.g. SDVOSB, 8(a)" style={inputStyle} />
        {!compact && <span className="hint">Comma-separated; matches set-aside (substring).</span>}
      </div>
    </>
  );
}

function CreateForm({ createSubscription, onCreated, lockedKind }: { createSubscription: (fd: FormData) => Promise<void>; onCreated: () => void; lockedKind?: Kind }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>(lockedKind ?? "opportunity");
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
        setError(err instanceof Error ? err.message : "Failed to create subscription");
      }
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="card" style={{ padding: 20, marginBottom: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <input type="hidden" name="kind" value={kind} />
      {!lockedKind && (
        <div className="field">
          <label>Kind</label>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="opportunity">Opportunity digest</option>
            <option value="award">Award digest</option>
          </select>
          <span className="hint">Which digest this subscription receives.</span>
        </div>
      )}
      <div className="field" style={{ gridColumn: lockedKind ? "1 / -1" : undefined }}>
        <label>Cadence</label>
        <select className="input" name="cadence" defaultValue="weekly">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
        <span className="hint">How often to send (daily driver honors this).</span>
      </div>
      <div className="field" style={{ gridColumn: "1 / -1" }}>
        <label>Recipients</label>
        <input className="input" name="recipients" placeholder="alice@lumiture.com, bob@lumiture.com" required />
        <span className="hint">Comma-separated email addresses.</span>
      </div>
      <div className="field">
        <label>Minimum fit score</label>
        <input className="input mono" name="min_fit_score" type="number" min={1} max={10} defaultValue={kind === "award" ? 6 : 7} required />
        <span className="hint">Gate for what&apos;s included (1–10).</span>
      </div>
      <div className="field">
        <label>Label <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>(optional)</span></label>
        <input className="input" name="label" placeholder="e.g. Leadership weekly digest" />
      </div>
      <FilterFields kind={kind} />
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, gridColumn: "1 / -1" }}>
        {error && <span style={{ fontSize: 12.5, color: "var(--err)", flex: 1 }}>{error}</span>}
        <button type="submit" className="btn accent" disabled={pending} style={{ marginLeft: "auto" }}>
          {pending ? <><Loader2 className="spin" style={{ width: 13, height: 13 }} /> Creating…</> : <><Plus style={{ width: 13, height: 13 }} /> Create</>}
        </button>
      </div>
    </form>
  );
}

function SubscriptionRow({
  subscription: s, showKind, toggleSubscription, deleteSubscription, updateSubscription, sendNow,
}: {
  subscription: Subscription;
  showKind: boolean;
  toggleSubscription: (fd: FormData) => Promise<void>;
  deleteSubscription: (fd: FormData) => Promise<void>;
  updateSubscription: (fd: FormData) => Promise<void>;
  sendNow: (fd: FormData) => Promise<void>;
}) {
  const [togglePending, startToggle] = useTransition();
  const [deletePending, startDelete] = useTransition();
  const [editPending, startEdit] = useTransition();
  const [sendPending, startSend] = useTransition();
  const [editing, setEditing] = useState(false);
  const [sentFlash, setSentFlash] = useState(false);
  const colSpan = showKind ? 8 : 7;

  function handleEditSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startEdit(async () => { await updateSubscription(fd); setEditing(false); });
  }

  const chips = filterChips(s);

  if (editing) {
    return (
      <tr style={{ borderBottom: "1px solid var(--line)", background: "var(--bg-2)" }}>
        <td colSpan={colSpan} style={{ padding: "12px 16px" }}>
          <form onSubmit={handleEditSubmit} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 10, alignItems: "start" }}>
            <input type="hidden" name="id" value={s.id} />
            <input type="hidden" name="kind" value={s.kind} />
            <div className="field" style={{ margin: 0 }}>
              <label style={{ fontSize: 11 }}>Recipients</label>
              <input className="input" name="recipients" defaultValue={s.recipients.join(", ")} required style={{ height: 30, fontSize: 13 }} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label style={{ fontSize: 11 }}>Cadence</label>
              <select className="input" name="cadence" defaultValue={s.cadence} style={{ height: 30, fontSize: 13 }}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label style={{ fontSize: 11 }}>Min fit</label>
              <input className="input mono" name="min_fit_score" type="number" min={1} max={10} defaultValue={s.min_fit_score} required style={{ height: 30, fontSize: 13 }} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label style={{ fontSize: 11 }}>Label</label>
              <input className="input" name="label" defaultValue={s.label ?? ""} placeholder="Optional" style={{ height: 30, fontSize: 13 }} />
            </div>
            <FilterFields kind={s.kind} s={s} compact />
            <div style={{ display: "flex", gap: 6, alignItems: "flex-end", gridColumn: "1 / -1" }}>
              <button type="submit" className="btn accent sm" disabled={editPending}>
                {editPending ? <Loader2 className="spin" style={{ width: 12, height: 12 }} /> : <Check style={{ width: 12, height: 12 }} />}
                {editPending ? "Saving…" : "Save"}
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setEditing(false)}><X style={{ width: 12, height: 12 }} /> Cancel</button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr style={{ borderBottom: "1px solid var(--line)" }}>
      {showKind && (
        <td style={{ padding: "12px 16px" }}>
          <span className="chip" style={{ fontSize: 11, textTransform: "capitalize" }}>{s.kind}</span>
        </td>
      )}
      <td style={{ padding: "12px 16px" }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)" }}>
          {s.label ?? <span style={{ color: "var(--ink-3)" }}>-</span>}
        </div>
        {chips.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
            {chips.map((c, i) => <span key={i} className="chip" style={{ fontSize: 11, color: "var(--ink-2)" }}>{c}</span>)}
          </div>
        )}
      </td>
      <td style={{ padding: "12px 16px" }}>
        <span style={{ fontSize: 12.5, color: "var(--ink-1)" }}>
          {s.recipients.length === 1 ? s.recipients[0] : `${s.recipients.length} recipients`}
        </span>
      </td>
      <td style={{ padding: "12px 16px" }}><span className="chip" style={{ fontSize: 12, textTransform: "capitalize" }}>{s.cadence}</span></td>
      <td style={{ padding: "12px 16px" }}><span className="mono" style={{ fontSize: 12.5, color: "var(--ink-1)" }}>{s.min_fit_score}</span></td>
      <td style={{ padding: "12px 16px" }}>
        <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
          {s.last_sent_at ? timeAgo(s.last_sent_at) : <span style={{ color: "var(--ink-3)" }}>Never</span>}
        </span>
      </td>
      <td style={{ padding: "12px 16px" }}>
        <span className={`chip ${s.is_active ? "ok" : ""}`} style={{ fontSize: 12 }}>{s.is_active ? "Active" : "Paused"}</span>
      </td>
      <td style={{ padding: "12px 16px", textAlign: "right", whiteSpace: "nowrap" }}>
        <form style={{ display: "inline" }} action={(fd) => startSend(async () => { await sendNow(fd); setSentFlash(true); setTimeout(() => setSentFlash(false), 2500); })}>
          <input type="hidden" name="id" value={s.id} />
          <input type="hidden" name="kind" value={s.kind} />
          <button type="submit" className="btn ghost sm" disabled={sendPending} title="Send the current digest now">
            {sendPending ? <Loader2 className="spin" style={{ width: 13, height: 13 }} /> : sentFlash ? <Check style={{ width: 13, height: 13, color: "var(--ok, #16a34a)" }} /> : <Send style={{ width: 13, height: 13 }} />}
          </button>
        </form>
        <button className="btn ghost sm" onClick={() => setEditing(true)} title="Edit"><Pencil style={{ width: 13, height: 13 }} /></button>
        <form style={{ display: "inline" }} action={(fd) => startToggle(async () => { await toggleSubscription(fd); })}>
          <input type="hidden" name="id" value={s.id} />
          <input type="hidden" name="is_active" value={String(s.is_active)} />
          <button type="submit" className="btn ghost sm" disabled={togglePending} title={s.is_active ? "Pause" : "Activate"}>
            {togglePending ? <Loader2 className="spin" style={{ width: 13, height: 13 }} /> : s.is_active ? <PowerOff style={{ width: 13, height: 13 }} /> : <Power style={{ width: 13, height: 13 }} />}
          </button>
        </form>
        <form style={{ display: "inline" }} action={(fd) => startDelete(async () => { await deleteSubscription(fd); })}>
          <input type="hidden" name="id" value={s.id} />
          <button type="submit" className="btn ghost sm" disabled={deletePending} title="Delete">
            {deletePending ? <Loader2 className="spin" style={{ width: 13, height: 13 }} /> : <Trash2 style={{ width: 13, height: 13 }} />}
          </button>
        </form>
      </td>
    </tr>
  );
}
