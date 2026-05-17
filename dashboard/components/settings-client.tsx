"use client";

import { useTheme } from "@/components/theme-provider";
import {
  Sun, Moon, Monitor, AlignJustify, Rows3, Loader2,
  Check, Bot, GitBranch, ChevronDown, ChevronUp, Save,
} from "lucide-react";
import { useTransition, useState } from "react";

// ─── Models available to pick ─────────────────────────────────────────────────

const MODELS = [
  { value: "claude-opus-4-7",           label: "Claude Opus 4.7",   desc: "Most capable · highest cost" },
  { value: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6", desc: "Balanced · default" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5",  desc: "Fastest · lowest cost" },
] as const;

const AGENT_META: Record<string, { label: string; role: string; color: string }> = {
  angie: { label: "Angie", role: "HR & Recruiting",                color: "oklch(62% 0.18 280)" },
  beady: { label: "Beady", role: "GovCon Business Development",    color: "oklch(58% 0.17 145)" },
  money: { label: "Money", role: "Finance & Analytics",            color: "oklch(62% 0.16 85)"  },
  patch: { label: "Patch", role: "IT Operations & Knowledge",      color: "oklch(60% 0.16 30)"  },
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface AgentConfig {
  agent_id: string;
  model: string;
  max_tokens: number;
  notes: string | null;
  updated_at: string;
}

interface OrchestrationType {
  id: string;
  name: string;
  version: number;
  description: string | null;
  is_active: boolean;
  cron: string | null;
  model: string | null;
  notes: string | null;
}

interface Props {
  userEmail: string;
  userCreatedAt: string | null;
  agentConfigs: AgentConfig[];
  orchestrations: OrchestrationType[];
  updateAgentConfig: (agentId: string, data: { model: string; max_tokens: number; notes: string | null }) => Promise<void>;
  updateOrchestrationConfig: (id: string, data: { description: string | null; model: string | null; notes: string | null; cron: string | null }) => Promise<void>;
}

// ─── Root ─────────────────────────────────────────────────────────────────────

type Tab = "account" | "agents" | "orchestrations" | "appearance";

export function SettingsClient({
  userEmail, userCreatedAt, agentConfigs, orchestrations,
  updateAgentConfig, updateOrchestrationConfig,
}: Props) {
  const [tab, setTab] = useState<Tab>("agents");

  const memberSince = userCreatedAt
    ? new Date(userCreatedAt).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : null;

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Settings</h1>
          <div className="sub">Configure agents, models, and platform preferences.</div>
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 24 }}>
        {(["agents", "orchestrations", "account", "appearance"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}
            style={{ textTransform: "capitalize" }}>
            {t}
          </button>
        ))}
      </div>

      {tab === "agents" && (
        <AgentsTab agentConfigs={agentConfigs} updateAgentConfig={updateAgentConfig} />
      )}
      {tab === "orchestrations" && (
        <OrchestrationsTab orchestrations={orchestrations} agentConfigs={agentConfigs} updateOrchestrationConfig={updateOrchestrationConfig} />
      )}
      {tab === "account" && (
        <div style={{ maxWidth: 580 }}>
          <Section heading="Account">
            <div className="card" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
              <SettingsRow label="Email">
                <span className="mono" style={{ fontSize: 13 }}>{userEmail}</span>
              </SettingsRow>
              <Divider />
              <SettingsRow label="Role"><span className="chip">ops</span></SettingsRow>
              {memberSince && (<><Divider /><SettingsRow label="Member since"><span style={{ fontSize: 13, color: "var(--ink-2)" }}>{memberSince}</span></SettingsRow></>)}
            </div>
          </Section>
        </div>
      )}
      {tab === "appearance" && <AppearanceTab />}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .settings-section { margin-bottom: 28px; }
        .settings-heading { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 8px; }
        .seg-ctrl { display: flex; gap: 4px; background: var(--surface-2, var(--bg-2)); border: 1px solid var(--line); border-radius: 8px; padding: 3px; }
        .seg-btn { display: flex; align-items: center; gap: 5px; padding: 5px 11px; border-radius: 5px; border: none; background: transparent; color: var(--ink-2); font-size: 12.5px; font-weight: 500; cursor: pointer; transition: background 120ms, color 120ms; white-space: nowrap; }
        .seg-btn:hover { color: var(--ink); }
        .seg-btn.active { background: var(--bg); color: var(--ink); box-shadow: 0 1px 3px oklch(0% 0 0 / .10); }
        .settings-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
        .settings-row-label { font-size: 13.5px; font-weight: 500; color: var(--ink); line-height: 1.4; }
        .settings-row-sub { font-size: 12px; color: var(--ink-3); margin-top: 2px; }
        .settings-divider { border: none; border-top: 1px solid var(--line); margin: 0; }
      `}</style>
    </div>
  );
}

// ─── Agents tab ───────────────────────────────────────────────────────────────

function AgentsTab({ agentConfigs, updateAgentConfig }: {
  agentConfigs: AgentConfig[];
  updateAgentConfig: Props["updateAgentConfig"];
}) {
  const configMap = new Map(agentConfigs.map((c) => [c.agent_id, c]));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <p style={{ fontSize: 13, color: "var(--ink-2)", margin: 0 }}>
        Changes apply to all new runs. In-progress runs continue using the model they started with.
      </p>
      {Object.entries(AGENT_META).map(([id, meta]) => {
        const cfg = configMap.get(id) ?? { agent_id: id, model: "claude-sonnet-4-6", max_tokens: 4096, notes: null, updated_at: "" };
        return <AgentCard key={id} agentId={id} meta={meta} config={cfg} updateAgentConfig={updateAgentConfig} />;
      })}
    </div>
  );
}

function AgentCard({ agentId, meta, config, updateAgentConfig }: {
  agentId: string;
  meta: { label: string; role: string; color: string };
  config: AgentConfig;
  updateAgentConfig: Props["updateAgentConfig"];
}) {
  const [model, setModel] = useState(config.model);
  const [notes, setNotes] = useState(config.notes ?? "");
  const [, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const dirty = model !== config.model || notes !== (config.notes ?? "");

  function save() {
    startTransition(async () => {
      await updateAgentConfig(agentId, { model, max_tokens: config.max_tokens, notes: notes.trim() || null });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    });
  }

  const selectedModel = MODELS.find((m) => m.value === model);
  const updatedAt = config.updated_at ? new Date(config.updated_at).toLocaleDateString() : null;

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 14, padding: "14px 18px",
        borderBottom: "1px solid var(--line)",
        background: `color-mix(in oklch, ${meta.color} 6%, var(--bg))`,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 9, flexShrink: 0,
          background: meta.color, display: "flex", alignItems: "center",
          justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 15,
        }}>
          {meta.label[0]}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, color: meta.color }}>{meta.label}</div>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{meta.role}</div>
        </div>
        {updatedAt && <div style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Updated {updatedAt}</div>}
      </div>

      {/* Body */}
      <div style={{ padding: "18px 18px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Model picker */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 8 }}>
            LLM Model
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {MODELS.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setModel(m.value)}
                style={{
                  padding: "8px 14px", borderRadius: 8, cursor: "pointer",
                  border: `1.5px solid ${model === m.value ? meta.color : "var(--line)"}`,
                  background: model === m.value ? `color-mix(in oklch, ${meta.color} 10%, var(--bg))` : "var(--bg-2)",
                  transition: "all 120ms", textAlign: "left",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: model === m.value ? meta.color : "var(--ink)" }}>
                  {m.label}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{m.desc}</div>
              </button>
            ))}
          </div>
          {selectedModel && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-3)" }}>
              Active: <span className="mono" style={{ fontSize: 11.5 }}>{model}</span>
            </div>
          )}
        </div>

        {/* Notes */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>
            Internal notes
          </div>
          <textarea
            className="ta"
            placeholder="Notes visible only to ops team…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={{ minHeight: 64, fontSize: 13, resize: "vertical" }}
          />
        </div>

        {/* Save */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {saved && <span className="chip ok"><Check style={{ width: 10, height: 10 }} /> Saved</span>}
          <button className="btn accent sm" onClick={save} disabled={!dirty}>
            <Save style={{ width: 12, height: 12 }} /> Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Orchestrations tab ───────────────────────────────────────────────────────

function OrchestrationsTab({ orchestrations, agentConfigs, updateOrchestrationConfig }: {
  orchestrations: OrchestrationType[];
  agentConfigs: AgentConfig[];
  updateOrchestrationConfig: Props["updateOrchestrationConfig"];
}) {
  const agentModel = new Map(agentConfigs.map((c) => [c.agent_id, c.model]));

  // Group by agent prefix
  const byAgent = new Map<string, OrchestrationType[]>();
  for (const o of orchestrations) {
    const prefix = o.name.split("/")[0] ?? "other";
    if (!byAgent.has(prefix)) byAgent.set(prefix, []);
    byAgent.get(prefix)!.push(o);
  }

  const agentOrder = ["angie", "beady", "money", "patch"];
  const sorted = [
    ...agentOrder.filter((a) => byAgent.has(a)),
    ...[...byAgent.keys()].filter((a) => !agentOrder.includes(a)),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <p style={{ fontSize: 13, color: "var(--ink-2)", margin: 0 }}>
        Per-orchestration settings override the agent default. Leave model blank to inherit from the agent.
      </p>
      {sorted.map((agentId) => {
        const meta = AGENT_META[agentId] ?? { label: agentId, role: "", color: "var(--accent)" };
        const orchs = byAgent.get(agentId) ?? [];
        const defaultModel = agentModel.get(agentId) ?? "claude-sonnet-4-6";
        return (
          <div key={agentId}>
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 14px", borderRadius: 8, marginBottom: 8,
              background: `color-mix(in oklch, ${meta.color} 8%, var(--bg-2))`,
              border: `1px solid color-mix(in oklch, ${meta.color} 20%, transparent)`,
            }}>
              <Bot style={{ width: 14, height: 14, color: meta.color }} />
              <span style={{ fontWeight: 700, fontSize: 13.5, color: meta.color }}>{meta.label}</span>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>·</span>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{meta.role}</span>
              <span className="chip muted" style={{ marginLeft: "auto", fontSize: 11 }}>
                default model: {defaultModel.split("-").slice(1, 3).join(" ")}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {orchs.map((o) => (
                <OrchRow key={o.id} orch={o} agentColor={meta.color} agentDefaultModel={defaultModel} updateOrchestrationConfig={updateOrchestrationConfig} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function OrchRow({ orch, agentColor, agentDefaultModel, updateOrchestrationConfig }: {
  orch: OrchestrationType;
  agentColor: string;
  agentDefaultModel: string;
  updateOrchestrationConfig: Props["updateOrchestrationConfig"];
}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(orch.description ?? "");
  const [model, setModel] = useState(orch.model ?? "");
  const [notes, setNotes] = useState(orch.notes ?? "");
  const [cron, setCron] = useState(orch.cron ?? "");
  const [, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const capName = orch.name.split("/").slice(1).join("/").replace(/-/g, " ");
  const dirty = description !== (orch.description ?? "") || model !== (orch.model ?? "")
    || notes !== (orch.notes ?? "") || cron !== (orch.cron ?? "");

  function save() {
    startTransition(async () => {
      await updateOrchestrationConfig(orch.id, {
        description: description.trim() || null,
        model: model.trim() || null,
        notes: notes.trim() || null,
        cron: cron.trim() || null,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    });
  }

  const effectiveModel = (model.trim() || agentDefaultModel).split("-").slice(1, 3).join(" ");

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {/* Row header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          padding: "10px 14px", background: "none", border: "none",
          cursor: "pointer", textAlign: "left",
        }}
      >
        <GitBranch style={{ width: 13, height: 13, color: agentColor, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, textTransform: "capitalize" }}>{capName}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)", marginLeft: 8 }}>{orch.name}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span className="chip muted" style={{ fontSize: 11 }}>{effectiveModel}</span>
          {orch.cron && <span className="chip" style={{ fontSize: 11 }}>cron</span>}
          {!orch.is_active && <span className="chip muted" style={{ fontSize: 11 }}>inactive</span>}
          {open ? <ChevronUp style={{ width: 14, height: 14, color: "var(--ink-3)" }} /> : <ChevronDown style={{ width: 14, height: 14, color: "var(--ink-3)" }} />}
        </div>
      </button>

      {/* Expanded config */}
      {open && (
        <div style={{ padding: "0 14px 14px", borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 12, paddingTop: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field" style={{ margin: 0 }}>
              <label style={{ fontSize: 11.5 }}>Description</label>
              <input className="input" style={{ fontSize: 13 }} placeholder="What this orchestration does…"
                value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label style={{ fontSize: 11.5 }}>Cron schedule <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>(blank = disabled)</span></label>
              <input className="input mono" style={{ fontSize: 13 }} placeholder="e.g. 0 8 * * 1"
                value={cron} onChange={(e) => setCron(e.target.value)} />
            </div>
          </div>

          {/* Model override */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>
              Model override <span style={{ textTransform: "none", fontWeight: 400 }}>— leave blank to use agent default ({agentDefaultModel.split("-").slice(1, 3).join(" ")})</span>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button type="button" onClick={() => setModel("")}
                style={{
                  padding: "6px 12px", borderRadius: 7, cursor: "pointer", fontSize: 12.5, fontWeight: 500,
                  border: `1.5px solid ${!model ? agentColor : "var(--line)"}`,
                  background: !model ? `color-mix(in oklch, ${agentColor} 10%, var(--bg))` : "var(--bg-2)",
                  color: !model ? agentColor : "var(--ink-2)",
                }}>
                Inherit from agent
              </button>
              {MODELS.map((m) => (
                <button key={m.value} type="button" onClick={() => setModel(m.value)}
                  style={{
                    padding: "6px 12px", borderRadius: 7, cursor: "pointer", fontSize: 12.5, fontWeight: 500,
                    border: `1.5px solid ${model === m.value ? agentColor : "var(--line)"}`,
                    background: model === m.value ? `color-mix(in oklch, ${agentColor} 10%, var(--bg))` : "var(--bg-2)",
                    color: model === m.value ? agentColor : "var(--ink-2)",
                  }}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 11.5 }}>Internal notes</label>
            <textarea className="ta" placeholder="Notes for the ops team…"
              value={notes} onChange={(e) => setNotes(e.target.value)}
              style={{ minHeight: 56, fontSize: 13, resize: "vertical" }} />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {saved && <span className="chip ok"><Check style={{ width: 10, height: 10 }} /> Saved</span>}
            <button className="btn accent sm" onClick={save} disabled={!dirty}>
              <Save style={{ width: 12, height: 12 }} /> Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Appearance tab ───────────────────────────────────────────────────────────

function AppearanceTab() {
  const { theme, density, setTheme, setDensity } = useTheme();
  return (
    <div style={{ maxWidth: 580 }}>
      <Section heading="Appearance">
        <div className="card" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          <SettingsRow label="Theme" sub="Choose light, dark, or follow the OS setting.">
            <div className="seg-ctrl">
              <SegBtn active={theme === "light"} onClick={() => setTheme("light")} icon={<Sun style={{ width: 13, height: 13 }} />} label="Light" />
              <SegBtn active={theme === "dark"} onClick={() => setTheme("dark")} icon={<Moon style={{ width: 13, height: 13 }} />} label="Dark" />
              <SegBtn active={theme === "system"} onClick={() => setTheme("system")} icon={<Monitor style={{ width: 13, height: 13 }} />} label="System" />
            </div>
          </SettingsRow>
          <Divider />
          <SettingsRow label="Density" sub="Compact reduces spacing for information-dense views.">
            <div className="seg-ctrl">
              <SegBtn active={density === "default"} onClick={() => setDensity("default")} icon={<AlignJustify style={{ width: 13, height: 13 }} />} label="Default" />
              <SegBtn active={density === "compact"} onClick={() => setDensity("compact")} icon={<Rows3 style={{ width: 13, height: 13 }} />} label="Compact" />
            </div>
          </SettingsRow>
        </div>
      </Section>
      <Section heading="About">
        <div className="card" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <SettingsRow label="Platform"><span style={{ fontSize: 13, color: "var(--ink-2)" }}>LumiAgents · Internal ops dashboard</span></SettingsRow>
          <Divider />
          <SettingsRow label="Runtime"><span style={{ fontSize: 13, color: "var(--ink-2)" }}>Cloudflare Workers + Workflows</span></SettingsRow>
          <Divider />
          <SettingsRow label="Data layer"><span style={{ fontSize: 13, color: "var(--ink-2)" }}>Supabase (Postgres + RLS)</span></SettingsRow>
        </div>
      </Section>
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h3 className="settings-heading">{heading}</h3>
      {children}
    </section>
  );
}

function SettingsRow({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-label">{label}</div>
        {sub && <div className="settings-row-sub">{sub}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function SegBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button className={`seg-btn${active ? " active" : ""}`} onClick={onClick} type="button">
      {icon}{label}
    </button>
  );
}

function Divider() { return <hr className="settings-divider" />; }
