"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Save, Check, Loader2, Power, Trash2, Info, ArrowLeft,
} from "lucide-react";
import {
  ALLOWED_MODELS,
  MAX_TOKENS_MIN,
  MAX_TOKENS_MAX,
  SYSTEM_PROMPT_MAX,
  knowledgeOptionsFor,
  type AgentManifestDraft,
  type SaveResult,
  type ToolMode,
} from "@/lib/agent-manifest";

// Tier 1 agent builder (#67). Ops-only composer for a NEW config agent (create) and the
// edit round-trip. The parent page renders it only for ops; the server actions re-check ops
// + RLS. Live validation here is a hint — the server action's validateConfigAgent() is
// authoritative and returns the per-field errors shown inline.

export interface OrchestrationOption {
  name: string;
  description: string | null;
  isActive: boolean;
  syncEligible: boolean;
}

interface ToolRow {
  orchestrationName: string;
  mode: ToolMode;
  paramsText: string; // raw JSON; parsed at submit
}

interface Props {
  mode: "create" | "edit";
  initial: AgentManifestDraft;
  lifecycle?: "active" | "disabled";
  orchestrations: OrchestrationOption[];
  createAgent: (m: AgentManifestDraft) => Promise<SaveResult>;
  updateAgent: (slug: string, m: AgentManifestDraft) => Promise<SaveResult>;
  setAgentLifecycle: (slug: string, l: "active" | "disabled") => Promise<SaveResult>;
  deleteAgent: (slug: string) => Promise<SaveResult>;
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
const ERR: React.CSSProperties = { color: "var(--err)", fontSize: 12, marginTop: 4 };

export default function AgentComposer(props: Props) {
  const { mode, initial, orchestrations } = props;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [ok, setOk] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [slug, setSlug] = useState(initial.slug);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [emoji, setEmoji] = useState(initial.emoji);
  const [category, setCategory] = useState(initial.category);
  const [description, setDescription] = useState(initial.description);
  const [prompts, setPrompts] = useState(initial.suggestedPrompts.join("\n"));
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt);
  const [model, setModel] = useState(initial.model);
  const [maxTokens, setMaxTokens] = useState(initial.maxTokens);
  const [tools, setTools] = useState<ToolRow[]>(
    initial.tools.map((t) => ({
      orchestrationName: t.orchestrationName,
      mode: t.mode,
      paramsText: t.params ? JSON.stringify(t.params) : "",
    })),
  );
  const [corpora, setCorpora] = useState<string[]>(initial.knowledgeCorpora);

  const knowledgeChoices = useMemo(() => knowledgeOptionsFor(slug), [slug]);

  function toggleTool(name: string) {
    setTools((prev) =>
      prev.some((t) => t.orchestrationName === name)
        ? prev.filter((t) => t.orchestrationName !== name)
        : [...prev, { orchestrationName: name, mode: "async", paramsText: "" }],
    );
  }
  function setToolMode(name: string, m: ToolMode) {
    setTools((prev) => prev.map((t) => (t.orchestrationName === name ? { ...t, mode: m } : t)));
  }
  function setToolParams(name: string, text: string) {
    setTools((prev) => prev.map((t) => (t.orchestrationName === name ? { ...t, paramsText: text } : t)));
  }
  function toggleCorpus(c: string) {
    setCorpora((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  function buildManifest(): { manifest?: AgentManifestDraft; paramErr?: Record<string, string> } {
    const parsedTools = [];
    const paramErr: Record<string, string> = {};
    for (const t of tools) {
      let params: Record<string, unknown> | null = null;
      const raw = t.paramsText.trim();
      if (raw) {
        try {
          const v = JSON.parse(raw);
          if (v && typeof v === "object" && !Array.isArray(v)) params = v as Record<string, unknown>;
          else paramErr.tools = `Params for ${t.orchestrationName} must be a JSON object.`;
        } catch {
          paramErr.tools = `Params for ${t.orchestrationName} must be valid JSON.`;
        }
      }
      parsedTools.push({ orchestrationName: t.orchestrationName, mode: t.mode, params });
    }
    if (Object.keys(paramErr).length > 0) return { paramErr };
    return {
      manifest: {
        slug, displayName, emoji, category, description,
        suggestedPrompts: prompts.split("\n").map((s) => s.trim()).filter(Boolean),
        systemPrompt, model, maxTokens, tools: parsedTools, knowledgeCorpora: corpora,
      },
    };
  }

  function save() {
    setOk(false);
    const { manifest, paramErr } = buildManifest();
    if (paramErr || !manifest) {
      setErrors(paramErr ?? {});
      return;
    }
    start(async () => {
      const res = mode === "create"
        ? await props.createAgent(manifest)
        : await props.updateAgent(slug, manifest);
      if (res.ok) {
        setErrors({});
        setOk(true);
        router.push(`/agents/${res.slug}`);
        router.refresh();
      } else {
        setErrors(res.errors);
      }
    });
  }

  function toggleLifecycle() {
    const next = props.lifecycle === "disabled" ? "active" : "disabled";
    start(async () => {
      const res = await props.setAgentLifecycle(slug, next);
      if (res.ok) router.refresh();
      else setErrors(res.errors);
    });
  }

  function remove() {
    if (!confirm(`Delete agent "${displayName || slug}"? This cannot be undone.`)) return;
    start(async () => {
      const res = await props.deleteAgent(slug);
      if (res.ok) {
        router.push("/agents");
        router.refresh();
      } else setErrors(res.errors);
    });
  }

  return (
    <div className="page view-fade" style={{ maxWidth: 820 }}>
      <div className="page-h">
        <div>
          <Link href="/agents" style={{ fontSize: 13, color: "var(--ink-3)", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <ArrowLeft size={14} /> Agents
          </Link>
          <h1 style={{ marginTop: 6 }}>{mode === "create" ? "New agent" : `Edit ${displayName || slug}`}</h1>
          <div className="sub">
            Assemble a new agent from existing orchestrations — no code, no deploy. It runs
            immediately through the shared chat runtime.
          </div>
        </div>
      </div>

      {mode === "create" && (
        <div style={{ ...CARD, display: "flex", gap: 10, alignItems: "flex-start", background: "var(--bg-2)" }}>
          <Info size={16} style={{ marginTop: 2, color: "var(--ink-3)" }} />
          <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
            An agent is a <strong>persona</strong> (system prompt), a <strong>model</strong>, a
            set of <strong>tools</strong> (each an existing orchestration), and a bounded
            <strong> knowledge scope</strong>. Pick tools from the catalogue below; a human
            reviews nothing — it goes live on save.
          </div>
        </div>
      )}

      {errors.form && <div style={{ ...CARD, borderColor: "var(--err)", color: "var(--err)", fontSize: 13 }}>{errors.form}</div>}

      {/* Identity + card */}
      <div style={CARD}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div>
            <label style={LABEL}>Slug</label>
            <input style={INPUT} value={slug} disabled={mode === "edit"}
              onChange={(e) => setSlug(e.target.value)} placeholder="insta-cleo" />
            {mode === "edit" && <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>Slug is fixed after creation.</div>}
            {errors.slug && <div style={ERR}>{errors.slug}</div>}
          </div>
          <div>
            <label style={LABEL}>Display name</label>
            <input style={INPUT} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Insta Cleo" />
            {errors.displayName && <div style={ERR}>{errors.displayName}</div>}
          </div>
          <div>
            <label style={LABEL}>Emoji</label>
            <input style={INPUT} value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="📸" />
            {errors.emoji && <div style={ERR}>{errors.emoji}</div>}
          </div>
          <div>
            <label style={LABEL}>Category</label>
            <input style={INPUT} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Eminence" />
            {errors.category && <div style={ERR}>{errors.category}</div>}
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={LABEL}>Description (card)</label>
            <input style={INPUT} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Drafts Instagram eminence content." />
            {errors.description && <div style={ERR}>{errors.description}</div>}
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={LABEL}>Suggested prompts (one per line, optional)</label>
            <textarea style={{ ...INPUT, minHeight: 64, resize: "vertical" }} value={prompts}
              onChange={(e) => setPrompts(e.target.value)} placeholder={"Draft an Instagram caption for this week's win"} />
          </div>
        </div>
      </div>

      {/* Persona */}
      <div style={CARD}>
        <label style={LABEL}>Persona (system prompt)</label>
        <textarea style={{ ...INPUT, minHeight: 160, resize: "vertical", fontFamily: "var(--mono)" }}
          value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="You are Insta Cleo, drafting visual-first Instagram captions..." />
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
          {systemPrompt.trim().length}/{SYSTEM_PROMPT_MAX}. A security guard against prompt
          injection is always appended by the runtime.
        </div>
        {errors.systemPrompt && <div style={ERR}>{errors.systemPrompt}</div>}
      </div>

      {/* Model */}
      <div style={CARD}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div>
            <label style={LABEL}>Model</label>
            <select style={INPUT} value={model} onChange={(e) => setModel(e.target.value)}>
              {ALLOWED_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            {errors.model && <div style={ERR}>{errors.model}</div>}
          </div>
          <div>
            <label style={LABEL}>Max tokens</label>
            <input style={INPUT} type="number" min={MAX_TOKENS_MIN} max={MAX_TOKENS_MAX}
              value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} />
            {errors.maxTokens && <div style={ERR}>{errors.maxTokens}</div>}
          </div>
        </div>
      </div>

      {/* Tools */}
      <div style={CARD}>
        <label style={LABEL}>Tools (existing orchestrations)</label>
        {errors.tools && <div style={{ ...ERR, marginTop: 0, marginBottom: 8 }}>{errors.tools}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 380, overflowY: "auto" }}>
          {orchestrations.length === 0 && <div style={{ fontSize: 13, color: "var(--ink-3)" }}>No orchestrations available.</div>}
          {orchestrations.map((o) => {
            const sel = tools.find((t) => t.orchestrationName === o.name);
            return (
              <div key={o.name} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10, opacity: o.isActive ? 1 : 0.55 }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: o.isActive ? "pointer" : "not-allowed" }}>
                  <input type="checkbox" checked={!!sel} disabled={!o.isActive}
                    onChange={() => toggleTool(o.name)} style={{ marginTop: 3 }} />
                  <span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600 }}>{o.name}</span>
                    {!o.isActive && <span style={{ fontSize: 11, color: "var(--ink-3)", marginLeft: 6 }}>(inactive)</span>}
                    {o.description && <span style={{ display: "block", fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{o.description}</span>}
                  </span>
                </label>
                {sel && (
                  <div style={{ marginTop: 8, paddingLeft: 26, display: "flex", flexDirection: "column", gap: 6 }}>
                    <label style={{ fontSize: 12, color: "var(--ink-2)", display: "flex", alignItems: "center", gap: 6 }}>
                      <input type="checkbox" checked={sel.mode === "sync"} disabled={!o.syncEligible}
                        onChange={(e) => setToolMode(o.name, e.target.checked ? "sync" : "async")} />
                      Await result (sync){!o.syncEligible && <span style={{ color: "var(--ink-3)" }}> — not read-only, async only</span>}
                    </label>
                    <input style={{ ...INPUT, fontSize: 12 }} value={sel.paramsText}
                      onChange={(e) => setToolParams(o.name, e.target.value)}
                      placeholder={'Fixed params JSON (optional), e.g. {"channel":"instagram"}'} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Knowledge */}
      <div style={CARD}>
        <label style={LABEL}>Knowledge corpora</label>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 8 }}>
          Bounded to shared, this agent&apos;s own corpus, and the enduser corpus. Restricted
          documents and other agents&apos; private corpora are never accessible.
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {knowledgeChoices.map((c) => (
            <label key={c} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={corpora.includes(c)} onChange={() => toggleCorpus(c)} />
              <span style={{ fontFamily: "var(--mono)" }}>{c}</span>
            </label>
          ))}
        </div>
        {errors.knowledgeCorpora && <div style={ERR}>{errors.knowledgeCorpora}</div>}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        <button onClick={save} disabled={pending} className="btn primary"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {pending ? <Loader2 size={16} className="spin" /> : ok ? <Check size={16} /> : <Save size={16} />}
          {mode === "create" ? "Create agent" : "Save changes"}
        </button>
        {mode === "edit" && (
          <>
            <button onClick={toggleLifecycle} disabled={pending} className="btn"
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Power size={16} /> {props.lifecycle === "disabled" ? "Enable" : "Disable"}
            </button>
            <button onClick={remove} disabled={pending} className="btn"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--err)", marginLeft: "auto" }}>
              <Trash2 size={16} /> Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}
