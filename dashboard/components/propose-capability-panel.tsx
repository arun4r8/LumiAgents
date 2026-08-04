"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GitPullRequest, Plus, Trash2, Loader2, ExternalLink, AlertTriangle, ShieldCheck, Wrench, Table2, Bot } from "lucide-react";
import type {
  ProposeCapabilityInput,
  ProposeColumn,
  ProposeColumnType,
  ProposeField,
  ProposeFieldType,
  ProposeResult,
} from "@/app/(dashboard)/agents/[slug]/propose-actions";

// Tier 2 agent builder (#67). Ops-only "Propose new capability" panel. Build 2 lets ops pick the
// KIND of proposal — a new tool (orchestration), a new data table, or a new dedicated-Worker agent
// — and fills the matching form; the server action forwards `kind` + the spec to the runtime, which
// opens a human-merge-gated PR. There is NO merge button — an ops engineer must review and merge
// the PR before anything goes live. The parent renders this for ops only; the server action +
// runtime re-check ops.

type Kind = "orchestration" | "table" | "agent";

interface Props {
  agentSlug: string;
  lifecycle: string;
  pendingPrUrl: string | null;
  pendingPrNumber: number | null;
  orchestrationNames: string[];
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
const COLUMN_TYPES: ProposeColumnType[] = ["text", "int", "bigint", "boolean", "timestamptz", "jsonb", "uuid", "date", "numeric"];

const KINDS: { id: Kind; label: string; icon: React.ReactNode; blurb: string }[] = [
  { id: "orchestration", label: "New tool", icon: <Wrench size={15} />, blurb: "A new orchestration/tool for this agent." },
  { id: "table", label: "New data table", icon: <Table2 size={15} />, blurb: "A new forward-only domain table (with RLS)." },
  { id: "agent", label: "New agent", icon: <Bot size={15} />, blurb: "A scaffold for a new dedicated-Worker agent." },
];

function emptyField(): ProposeField {
  return { name: "", type: "string", description: "", optional: false };
}
function emptyColumn(): ProposeColumn {
  return { name: "", type: "text", nullable: true };
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

function ColumnEditor({ columns, setColumns }: { columns: ProposeColumn[]; setColumns: (c: ProposeColumn[]) => void }) {
  const update = (i: number, patch: Partial<ProposeColumn>) =>
    setColumns(columns.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={LABEL}>Columns</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {columns.map((c, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 150px auto auto", gap: 8, alignItems: "center" }}>
            <input style={INPUT} value={c.name} placeholder="column_name"
              onChange={(e) => update(i, { name: e.target.value })} />
            <select style={INPUT} value={c.type}
              onChange={(e) => update(i, { type: e.target.value as ProposeColumnType })}>
              {COLUMN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-2)" }}>
              <input type="checkbox" checked={c.nullable} onChange={(e) => update(i, { nullable: e.target.checked })} />
              nullable
            </label>
            <button type="button" className="btn" onClick={() => setColumns(columns.filter((_, idx) => idx !== i))}
              disabled={columns.length === 1} title="Remove column"
              style={{ display: "inline-flex", alignItems: "center", padding: "6px 8px" }}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
        <span style={{ fontFamily: "var(--mono)" }}>id</span>, <span style={{ fontFamily: "var(--mono)" }}>created_at</span> and{" "}
        <span style={{ fontFamily: "var(--mono)" }}>updated_at</span> are added automatically.
      </div>
      <button type="button" className="btn" onClick={() => setColumns([...columns, emptyColumn()])}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 13 }}>
        <Plus size={14} /> Add column
      </button>
    </div>
  );
}

export default function ProposeCapabilityPanel(props: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("orchestration");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ prUrl: string; prNumber: number; branch: string } | null>(null);

  // Orchestration form
  const [capabilitySlug, setCapabilitySlug] = useState("");
  const [description, setDescription] = useState("");
  const [intent, setIntent] = useState("");
  const [inputFields, setInputFields] = useState<ProposeField[]>([emptyField()]);
  const [output, setOutput] = useState<ProposeField[]>([emptyField()]);

  // Table form
  const [tableName, setTableName] = useState("");
  const [tableDescription, setTableDescription] = useState("");
  const [columns, setColumns] = useState<ProposeColumn[]>([emptyColumn()]);
  const [enduserReadable, setEnduserReadable] = useState(false);

  // Agent form
  const [agentSlugField, setAgentSlugField] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [category, setCategory] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [persona, setPersona] = useState("");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [secrets, setSecrets] = useState("");

  function buildInput(): ProposeCapabilityInput {
    if (kind === "table") {
      return {
        kind: "table",
        tableName: tableName.trim(),
        description: tableDescription.trim() || undefined,
        enduserReadable,
        columns: columns.map((c) => ({ ...c, name: c.name.trim() })),
      };
    }
    if (kind === "agent") {
      return {
        kind: "agent",
        slug: agentSlugField.trim(),
        displayName: displayName.trim(),
        card: {
          emoji: emoji.trim() || undefined,
          category: category.trim() || undefined,
          description: agentDescription.trim() || undefined,
        },
        persona: persona.trim(),
        tools: selectedTools,
        secrets: secrets.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
      };
    }
    return {
      kind: "orchestration",
      agentSlug: props.agentSlug,
      capabilitySlug: capabilitySlug.trim(),
      description: description.trim(),
      intent: intent.trim(),
      inputFields: inputFields.map((f) => ({ ...f, name: f.name.trim(), description: f.description.trim() })),
      output: output.map((f) => ({ ...f, name: f.name.trim(), description: f.description.trim() })),
    };
  }

  function submit() {
    setError(null);
    setResult(null);
    const input = buildInput();
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

  function toggleTool(name: string) {
    setSelectedTools((cur) => (cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name]));
  }

  return (
    <div className="page view-fade" style={{ maxWidth: 820, paddingTop: 0 }}>
      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <GitPullRequest size={18} style={{ color: "var(--ink-2)" }} />
          <h2 style={{ fontSize: 16, margin: 0 }}>Propose a new capability</h2>
        </div>
        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
          A new capability needs code (a new tool, a new data table, or a whole new agent), so it
          cannot go live from the dashboard. Describe it below and the app will <strong>draft the
          code and open a pull request</strong>. An ops engineer must review and merge that PR; only
          then does the capability go live. The app never merges.
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

          {/* Kind picker */}
          <div style={{ marginBottom: 16 }}>
            <label style={LABEL}>What are you proposing?</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {KINDS.map((k) => {
                const active = kind === k.id;
                return (
                  <button key={k.id} type="button" onClick={() => setKind(k.id)}
                    style={{
                      textAlign: "left", padding: 12, borderRadius: 10, cursor: "pointer",
                      border: `1px solid ${active ? "var(--accent, #2563eb)" : "var(--line)"}`,
                      background: active ? "var(--bg-2)" : "var(--bg-1)", color: "var(--ink-1)",
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}>
                      {k.icon} {k.label}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>{k.blurb}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── New tool (orchestration) ── */}
          {kind === "orchestration" && (
            <>
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
            </>
          )}

          {/* ── New data table ── */}
          {kind === "table" && (
            <>
              <div style={{ marginBottom: 12 }}>
                <label style={LABEL}>Table name (snake_case)</label>
                <input style={INPUT} value={tableName} placeholder="reels_ideas"
                  onChange={(e) => setTableName(e.target.value)} />
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
                  Created as <span style={{ fontFamily: "var(--mono)" }}>orchestration.{tableName || "…"}</span>, RLS on, ops-only by default.
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={LABEL}>Description (optional)</label>
                <input style={INPUT} value={tableDescription} placeholder="Reel ideas Cleo plans against."
                  onChange={(e) => setTableDescription(e.target.value)} />
              </div>
              <ColumnEditor columns={columns} setColumns={setColumns} />
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-2)", marginBottom: 12 }}>
                <input type="checkbox" checked={enduserReadable} onChange={(e) => setEnduserReadable(e.target.checked)} />
                Also allow end users to read this table (adds an enduser SELECT policy)
              </label>
            </>
          )}

          {/* ── New dedicated-Worker agent ── */}
          {kind === "agent" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={LABEL}>Agent slug (kebab-case)</label>
                  <input style={INPUT} value={agentSlugField} placeholder="sales-scout"
                    onChange={(e) => setAgentSlugField(e.target.value)} />
                </div>
                <div>
                  <label style={LABEL}>Display name</label>
                  <input style={INPUT} value={displayName} placeholder="Sales Scout"
                    onChange={(e) => setDisplayName(e.target.value)} />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={LABEL}>Emoji</label>
                  <input style={INPUT} value={emoji} placeholder="🔭" onChange={(e) => setEmoji(e.target.value)} />
                </div>
                <div>
                  <label style={LABEL}>Category</label>
                  <input style={INPUT} value={category} placeholder="Business Development"
                    onChange={(e) => setCategory(e.target.value)} />
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={LABEL}>Card description (one line)</label>
                <input style={INPUT} value={agentDescription} placeholder="Scouts new sales leads and qualifies them."
                  onChange={(e) => setAgentDescription(e.target.value)} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={LABEL}>Persona (system prompt)</label>
                <textarea style={{ ...INPUT, minHeight: 120, resize: "vertical" }} value={persona}
                  placeholder="You are Sales Scout, Lumiture's business-development assistant. You help with…"
                  onChange={(e) => setPersona(e.target.value)} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={LABEL}>Tools (existing orchestrations only)</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflowY: "auto" }}>
                  {props.orchestrationNames.length === 0 && (
                    <div style={{ fontSize: 12, color: "var(--ink-3)" }}>No orchestrations available.</div>
                  )}
                  {props.orchestrationNames.map((name) => {
                    const on = selectedTools.includes(name);
                    return (
                      <button key={name} type="button" onClick={() => toggleTool(name)}
                        style={{
                          fontFamily: "var(--mono)", fontSize: 12, padding: "5px 9px", borderRadius: 999, cursor: "pointer",
                          border: `1px solid ${on ? "var(--accent, #2563eb)" : "var(--line)"}`,
                          background: on ? "var(--accent, #2563eb)" : "var(--bg-1)",
                          color: on ? "#fff" : "var(--ink-2)",
                        }}>
                        {name}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
                  A new agent may only wire orchestrations that already exist. Need a new tool? Propose it first.
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={LABEL}>Secret names it will need (optional)</label>
                <input style={INPUT} value={secrets} placeholder="SALES_SCOUT_API_KEY"
                  onChange={(e) => setSecrets(e.target.value)} />
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
                  NAMES only, comma/space separated. An ops engineer provisions the values out-of-band. Never paste a secret value.
                </div>
              </div>
            </>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink-3)", marginTop: 4, marginBottom: 12 }}>
            <ShieldCheck size={14} /> Machine-drafted code is never run before merge. An ops engineer reviews every line, then merges. The app cannot merge.
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
