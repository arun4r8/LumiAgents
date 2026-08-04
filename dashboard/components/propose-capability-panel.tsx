"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GitPullRequest, Plus, Trash2, Loader2, ExternalLink, AlertTriangle, ShieldCheck } from "lucide-react";
import type {
  ProposeCapabilityInput,
  ProposeField,
  ProposeFieldType,
  ProposeResult,
} from "@/app/(dashboard)/agents/[slug]/propose-actions";

// Tier 2 agent builder (#67). Ops-only "Propose new capability" panel. Collects a small spec
// (name, description, what it should do, input/output fields) and calls the proposeCapability
// server action, which opens a human-merge-gated PR. There is NO merge button — an ops engineer
// must review and merge the PR before the capability goes live. The parent renders this for ops
// only; the server action + runtime re-check ops.

interface Props {
  agentSlug: string;
  lifecycle: string;
  pendingPrUrl: string | null;
  pendingPrNumber: number | null;
  proposeCapability: (input: ProposeCapabilityInput) => Promise<ProposeResult>;
}

const LABEL: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: "var(--ink-3)",
  textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6, display: "block",
};
const INPUT: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 8,
  border: "1px solid var(--line)", background: "var(--bg-1)", color: "var(--ink-1)", fontSize: 14,
};
const CARD: React.CSSProperties = {
  border: "1px solid var(--line)", borderRadius: 12, padding: 16,
  background: "var(--bg-1)", marginBottom: 16,
};
const TYPES: ProposeFieldType[] = ["string", "number", "boolean"];

function emptyField(): ProposeField {
  return { name: "", type: "string", description: "", optional: false };
}

function FieldEditor({
  title, fields, setFields,
}: {
  title: string;
  fields: ProposeField[];
  setFields: (f: ProposeField[]) => void;
}) {
  const update = (i: number, patch: Partial<ProposeField>) =>
    setFields(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={LABEL}>{title}</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {fields.map((f, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 120px 2fr auto", gap: 8, alignItems: "center" }}>
            <input style={INPUT} value={f.name} placeholder="fieldName"
              onChange={(e) => update(i, { name: e.target.value })} />
            <select style={INPUT} value={f.type}
              onChange={(e) => update(i, { type: e.target.value as ProposeFieldType })}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input style={INPUT} value={f.description} placeholder="what this field is"
              onChange={(e) => update(i, { description: e.target.value })} />
            <button type="button" className="btn" onClick={() => setFields(fields.filter((_, idx) => idx !== i))}
              disabled={fields.length === 1} title="Remove field"
              style={{ display: "inline-flex", alignItems: "center", padding: "6px 8px" }}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn" onClick={() => setFields([...fields, emptyField()])}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 13 }}>
        <Plus size={14} /> Add field
      </button>
    </div>
  );
}

export default function ProposeCapabilityPanel(props: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ prUrl: string; prNumber: number; branch: string } | null>(null);

  const [capabilitySlug, setCapabilitySlug] = useState("");
  const [description, setDescription] = useState("");
  const [intent, setIntent] = useState("");
  const [inputFields, setInputFields] = useState<ProposeField[]>([emptyField()]);
  const [output, setOutput] = useState<ProposeField[]>([emptyField()]);

  function submit() {
    setError(null);
    setResult(null);
    const input: ProposeCapabilityInput = {
      agentSlug: props.agentSlug,
      capabilitySlug: capabilitySlug.trim(),
      description: description.trim(),
      intent: intent.trim(),
      inputFields: inputFields.map((f) => ({ ...f, name: f.name.trim(), description: f.description.trim() })),
      output: output.map((f) => ({ ...f, name: f.name.trim(), description: f.description.trim() })),
    };
    start(async () => {
      const res = await props.proposeCapability(input);
      if (res.ok) {
        setResult({ prUrl: res.prUrl, prNumber: res.prNumber, branch: res.branch });
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="page view-fade" style={{ maxWidth: 820, paddingTop: 0 }}>
      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <GitPullRequest size={18} style={{ color: "var(--ink-2)" }} />
          <h2 style={{ fontSize: 16, margin: 0 }}>Propose a new capability</h2>
        </div>
        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
          A new capability needs code (a new orchestration/tool), so it cannot go live from the
          dashboard. Describe it below and the app will <strong>draft the code and open a pull
          request</strong>. An ops engineer must review and merge that PR; only then does the
          capability go live. The app never merges.
        </div>

        {/* Current proposed state / pending PR */}
        {props.lifecycle === "proposed" && props.pendingPrUrl && (
          <div style={{ ...CARD, marginTop: 12, marginBottom: 0, background: "var(--bg-2)", borderColor: "var(--line)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-1)" }}>
              <AlertTriangle size={16} style={{ color: "var(--warn, #b7791f)" }} />
              This agent is <strong>&nbsp;proposed</strong>&nbsp;— a capability PR is open and awaiting an ops review + merge.
            </div>
            <a href={props.pendingPrUrl} target="_blank" rel="noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 13, color: "var(--accent, #2563eb)" }}>
              <ExternalLink size={14} /> Review PR #{props.pendingPrNumber}
            </a>
          </div>
        )}

        {!open && !result && (
          <button className="btn primary" onClick={() => setOpen(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 12 }}>
            <Plus size={16} /> Propose a capability
          </button>
        )}
      </div>

      {open && !result && (
        <div style={CARD}>
          {error && (
            <div style={{ ...CARD, borderColor: "var(--err)", color: "var(--err)", fontSize: 13, marginBottom: 12 }}>{error}</div>
          )}
          <div style={{ marginBottom: 12 }}>
            <label style={LABEL}>Capability name (kebab-case)</label>
            <input style={INPUT} value={capabilitySlug} placeholder="reels-plan"
              onChange={(e) => setCapabilitySlug(e.target.value)} />
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
              Becomes the orchestration <span style={{ fontFamily: "var(--mono)" }}>{props.agentSlug}/{capabilitySlug || "…"}</span>.
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={LABEL}>Description (one line)</label>
            <input style={INPUT} value={description} placeholder="Plan a run of Reels for a content theme."
              onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={LABEL}>What should it do?</label>
            <textarea style={{ ...INPUT, minHeight: 100, resize: "vertical" }} value={intent}
              placeholder="Given a theme, propose 5 reels ideas grounded in the company profile and write them back to the calendar."
              onChange={(e) => setIntent(e.target.value)} />
          </div>

          <FieldEditor title="Inputs" fields={inputFields} setFields={setInputFields} />
          <FieldEditor title="Outputs" fields={output} setFields={setOutput} />

          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink-3)", marginTop: 4, marginBottom: 12 }}>
            <ShieldCheck size={14} /> The generated run() body is a machine proposal that is never run before merge. A human reviews every line.
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn primary" disabled={pending} onClick={submit}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {pending ? <Loader2 size={16} className="spin" /> : <GitPullRequest size={16} />}
              Draft &amp; open PR
            </button>
            <button className="btn" disabled={pending} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {result && (
        <div style={{ ...CARD, borderColor: "var(--ok, #16a34a)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, marginBottom: 8 }}>
            <GitPullRequest size={18} style={{ color: "var(--ok, #16a34a)" }} />
            <strong>Proposed. PR #{result.prNumber} is open.</strong>
          </div>
          <div style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: 10 }}>
            An ops engineer must review and merge this PR. After it merges, the capability is
            registered and goes live. Nothing has shipped yet.
          </div>
          <a href={result.prUrl} target="_blank" rel="noreferrer" className="btn"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ExternalLink size={14} /> Open PR #{result.prNumber}
          </a>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8, fontFamily: "var(--mono)" }}>branch: {result.branch}</div>
        </div>
      )}
    </div>
  );
}
