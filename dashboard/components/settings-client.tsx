"use client";

import { useTheme } from "@/components/theme-provider";
import {
  Sun, Moon, Monitor, AlignJustify, Rows3, Loader2,
  Check, Bot, GitBranch, ChevronDown, ChevronUp, Save,
  UserPlus, Copy, Trash2, Send,
} from "lucide-react";
import { useTransition, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { AgentMark } from "@/components/agent-mark";
import { agentColor } from "@/lib/agent-style";
import { SubscriptionsClient, type Subscription, type SubscriptionKind } from "@/components/subscriptions-client";

// ─── Models available to pick ─────────────────────────────────────────────────

const MODELS = [
  { value: "claude-opus-4-7",           label: "Claude Opus 4.7",   desc: "Most capable · highest cost" },
  { value: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6", desc: "Balanced · default" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5",  desc: "Fastest · lowest cost" },
] as const;

// Colours come from the shared agent identity tokens (app/lumi.css), not a
// third private palette — this file used to disagree with lib/agent-style on
// cleo's and dewey's hues.
const AGENT_META: Record<string, { label: string; role: string; color: string }> = {
  angie: { label: "Angie", role: "HR & Recruiting",                color: agentColor("angie") },
  beady: { label: "Beady", role: "GovCon Business Development",    color: agentColor("beady") },
  cleo:  { label: "Cleo",  role: "Eminence, Awards & Proposals",   color: agentColor("cleo")  },
  dewey: { label: "Dewey", role: "Knowledge Librarian",            color: agentColor("dewey") },
  money: { label: "Money", role: "Finance & Analytics",            color: agentColor("money") },
  patch: { label: "Patch", role: "IT Operations",                  color: agentColor("patch") },
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

export interface TeamMember {
  id: string;
  email: string;
  role: string;
  status: "active" | "invited";
  created_at: string;
}

interface Props {
  userId: string;
  userEmail: string;
  userCreatedAt: string | null;
  isOps: boolean;
  /** ?tab= from the URL — this is what makes /subscriptions 308 onto a tab. */
  initialTab?: string;
  members: TeamMember[];
  agentConfigs: AgentConfig[];
  orchestrations: OrchestrationType[];
  subscriptions: Subscription[];
  subscriptionsIntro: string;
  subscriptionsInitialKind: SubscriptionKind | "all";
  emailConfigured: boolean;
  updateAgentConfig: (agentId: string, data: { model: string; max_tokens: number; notes: string | null }) => Promise<void>;
  updateOrchestrationConfig: (id: string, data: { description: string | null; model: string | null; notes: string | null; cron: string | null }) => Promise<void>;
  inviteMember: (formData: FormData) => Promise<{ link: string; email: string; role: "ops" | "enduser" }>;
  revokeMember: (formData: FormData) => Promise<void>;
  resendInvite: (formData: FormData) => Promise<{ link: string }>;
  createSubscription: (formData: FormData) => Promise<void>;
  updateSubscription: (formData: FormData) => Promise<void>;
  toggleSubscription: (formData: FormData) => Promise<void>;
  deleteSubscription: (formData: FormData) => Promise<void>;
  sendNow: (formData: FormData) => Promise<void>;
}

// ─── Root ─────────────────────────────────────────────────────────────────────

type Tab = "account" | "agents" | "orchestrations" | "team" | "subscriptions" | "appearance";

const TAB_LABEL: Record<Tab, string> = {
  account: "Account",
  agents: "Agents",
  orchestrations: "Orchestrations",
  team: "Team",
  subscriptions: "Subscriptions",
  appearance: "Appearance",
};

export function SettingsClient({
  userId, userEmail, userCreatedAt, isOps, initialTab, members, agentConfigs, orchestrations,
  subscriptions, subscriptionsIntro, subscriptionsInitialKind, emailConfigured,
  updateAgentConfig, updateOrchestrationConfig,
  inviteMember, revokeMember, resendInvite,
  createSubscription, updateSubscription, toggleSubscription, deleteSubscription, sendNow,
}: Props) {
  // Agents/orchestrations config, team and subscriptions are ops-only; endusers
  // get account + appearance (they need account to change their password).
  const tabs: Tab[] = isOps
    ? ["agents", "orchestrations", "team", "subscriptions", "account", "appearance"]
    : ["account", "appearance"];
  const requested = tabs.find((t) => t === initialTab);
  const [tab, setTab] = useState<Tab>(requested ?? (isOps ? "agents" : "account"));

  const memberSince = userCreatedAt
    ? new Date(userCreatedAt).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : null;

  return (
    <div className="page view-fade">
      <h1 className="p6-h1">Settings</h1>
      <div className="p6-sub" style={{ marginBottom: 22 }}>Configure agents, models, and platform preferences.</div>

      <div className="tabs" style={{ marginBottom: 24 }}>
        {tabs.map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === "agents" && isOps && (
        <AgentsTab agentConfigs={agentConfigs} updateAgentConfig={updateAgentConfig} />
      )}
      {tab === "orchestrations" && isOps && (
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
              <SettingsRow label="Role"><span className="chip">{isOps ? "ops" : "enduser"}</span></SettingsRow>
              {memberSince && (<><Divider /><SettingsRow label="Member since"><span style={{ fontSize: 13, color: "var(--ink-2)" }}>{memberSince}</span></SettingsRow></>)}
            </div>
          </Section>
          <Section heading="Security">
            <ChangePasswordSection />
          </Section>
        </div>
      )}
      {tab === "team" && isOps && (
        <TeamTab
          currentUserId={userId}
          members={members}
          inviteMember={inviteMember}
          revokeMember={revokeMember}
          resendInvite={resendInvite}
        />
      )}
      {tab === "subscriptions" && isOps && (
        <SubscriptionsClient
          subscriptions={subscriptions}
          intro={subscriptionsIntro}
          initialTab={subscriptionsInitialKind}
          emailConfigured={emailConfigured}
          embedded
          createSubscription={createSubscription}
          toggleSubscription={toggleSubscription}
          deleteSubscription={deleteSubscription}
          updateSubscription={updateSubscription}
          sendNow={sendNow}
        />
      )}
      {tab === "appearance" && <AppearanceTab />}
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
        <AgentMark slug={agentId} name={meta.label} size={34} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 14.5, color: "var(--color-text)" }}>{meta.label}</div>
          <div style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{meta.role}</div>
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
                  padding: "8px 14px", borderRadius: 6, cursor: "pointer",
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
          <button className="btn primary sm" onClick={save} disabled={!dirty}>
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
              padding: "10px 14px", borderRadius: 6, marginBottom: 8,
              background: `color-mix(in oklch, ${meta.color} 8%, var(--bg-2))`,
              border: `1px solid color-mix(in oklch, ${meta.color} 20%, transparent)`,
            }}>
              <Bot style={{ width: 14, height: 14, color: meta.color }} />
              <span style={{ fontWeight: 600, fontSize: 13.5, color: meta.color }}>{meta.label}</span>
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
              Model override <span style={{ textTransform: "none", fontWeight: 400 }}>(leave blank to use agent default: {agentDefaultModel.split("-").slice(1, 3).join(" ")})</span>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button type="button" onClick={() => setModel("")}
                style={{
                  padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12.5, fontWeight: 500,
                  border: `1.5px solid ${!model ? agentColor : "var(--line)"}`,
                  background: !model ? `color-mix(in oklch, ${agentColor} 10%, var(--bg))` : "var(--bg-2)",
                  color: !model ? agentColor : "var(--ink-2)",
                }}>
                Inherit from agent
              </button>
              {MODELS.map((m) => (
                <button key={m.value} type="button" onClick={() => setModel(m.value)}
                  style={{
                    padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12.5, fontWeight: 500,
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
            <button className="btn primary sm" onClick={save} disabled={!dirty}>
              <Save style={{ width: 12, height: 12 }} /> Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Team tab ─────────────────────────────────────────────────────────────────

function TeamTab({ currentUserId, members, inviteMember, revokeMember, resendInvite }: {
  currentUserId: string;
  members: TeamMember[];
  inviteMember: Props["inviteMember"];
  revokeMember: Props["revokeMember"];
  resendInvite: Props["resendInvite"];
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"ops" | "enduser">("enduser");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ link: string; email: string; role: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInvite(null);
    const fd = new FormData();
    fd.set("email", email);
    fd.set("role", role);
    startTransition(async () => {
      try {
        const res = await inviteMember(fd);
        setInvite(res);
        setEmail("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not create invite.");
      }
    });
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 820 }}>
      {/* Invite form */}
      <Section heading="Invite a member">
        <div className="card" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ fontSize: 13, color: "var(--ink-2)", margin: 0 }}>
            Create a single-use invite link and send it to the person yourself. No email is sent. Self-signup is disabled.
          </p>
          <form onSubmit={submitInvite} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="field" style={{ margin: 0, flex: "1 1 240px" }}>
              <label style={{ fontSize: 12 }}>Email</label>
              <input
                className="input"
                type="email"
                placeholder="person@lumiture.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ fontSize: 13 }}
                required
              />
            </div>
            <div className="field" style={{ margin: 0, flex: "0 0 160px" }}>
              <label style={{ fontSize: 12 }}>Role</label>
              <select
                className="sel"
                value={role}
                onChange={(e) => setRole(e.target.value as "ops" | "enduser")}
                style={{ fontSize: 13 }}
              >
                <option value="enduser">enduser</option>
                <option value="ops">ops</option>
              </select>
            </div>
            <button className="btn primary" type="submit" disabled={pending} style={{ height: 34 }}>
              {pending
                ? <Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} />
                : <UserPlus style={{ width: 13, height: 13 }} />}
              Create invite
            </button>
          </form>

          {error && <div style={{ fontSize: 12.5, color: "var(--err)" }}>{error}</div>}

          {invite && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-1)" }}>Invite link</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="input mono"
                  readOnly
                  value={invite.link}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{ fontSize: 12, flex: 1 }}
                />
                <button className="btn" type="button" onClick={() => copyLink(invite.link)} style={{ height: 34 }}>
                  {copied
                    ? <><Check style={{ width: 13, height: 13 }} /> Copied</>
                    : <><Copy style={{ width: 13, height: 13 }} /> Copy</>}
                </button>
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                Send this link to {invite.email}. It&apos;s single-use and tied to their email.
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* Members table */}
      <Section heading="Members">
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="tbl" style={{ minWidth: 620 }}>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 && (
                <tr><td colSpan={5} style={{ color: "var(--ink-3)", cursor: "default" }}>No members yet.</td></tr>
              )}
              {members.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  isSelf={m.id === currentUserId}
                  revokeMember={revokeMember}
                  resendInvite={resendInvite}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function MemberRow({ member, isSelf, revokeMember, resendInvite }: {
  member: TeamMember;
  isSelf: boolean;
  revokeMember: Props["revokeMember"];
  resendInvite: Props["resendInvite"];
}) {
  const [pending, startTransition] = useTransition();
  const [rowLink, setRowLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const created = member.created_at
    ? new Date(member.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "-";

  function revoke() {
    if (!confirm(`Remove ${member.email}? This deletes their account.`)) return;
    setError(null);
    const fd = new FormData();
    fd.set("userId", member.id);
    startTransition(async () => {
      try {
        await revokeMember(fd);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not remove member.");
      }
    });
  }

  function resend() {
    setError(null);
    setRowLink(null);
    const fd = new FormData();
    fd.set("email", member.email);
    startTransition(async () => {
      try {
        const res = await resendInvite(fd);
        setRowLink(res.link);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not regenerate invite.");
      }
    });
  }

  async function copyRow(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <tr style={{ cursor: "default" }}>
        <td className="mono" style={{ fontSize: 12.5 }}>{member.email}</td>
        <td><span className={`chip${member.role === "ops" ? " accent" : " muted"}`}>{member.role}</span></td>
        <td>
          <span className={`chip${member.status === "active" ? " ok" : " info"}`}>{member.status}</span>
        </td>
        <td style={{ color: "var(--ink-2)", fontSize: 12.5 }}>{created}</td>
        <td>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
            {member.status === "invited" && (
              <button className="btn sm" type="button" onClick={resend} disabled={pending}>
                <Send style={{ width: 11, height: 11 }} /> Resend
              </button>
            )}
            {!isSelf && (
              <button className="btn danger-out sm" type="button" onClick={revoke} disabled={pending}>
                <Trash2 style={{ width: 11, height: 11 }} /> Revoke
              </button>
            )}
          </div>
        </td>
      </tr>
      {(rowLink || error) && (
        <tr style={{ cursor: "default" }}>
          <td colSpan={5} style={{ background: "var(--bg-1)" }}>
            {error && <div style={{ fontSize: 12, color: "var(--err)" }}>{error}</div>}
            {rowLink && (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  className="input mono"
                  readOnly
                  value={rowLink}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{ fontSize: 12, flex: 1 }}
                />
                <button className="btn sm" type="button" onClick={() => copyRow(rowLink)}>
                  {copied
                    ? <><Check style={{ width: 11, height: 11 }} /> Copied</>
                    : <><Copy style={{ width: 11, height: 11 }} /> Copy</>}
                </button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Change password ──────────────────────────────────────────────────────────

function ChangePasswordSection() {
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const canSubmit = newPassword.length >= 6 && newPassword === confirm && status !== "loading";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setStatus("loading");
    setErrorMsg("");
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      setErrorMsg(error.message);
      setStatus("error");
    } else {
      setStatus("success");
      setNewPassword("");
      setConfirm("");
      setTimeout(() => setStatus("idle"), 3000);
    }
  }

  return (
    <div className="card" style={{ padding: "16px 20px" }}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="field" style={{ margin: 0 }}>
          <label style={{ fontSize: 12 }}>New password <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>(min 6 characters)</span></label>
          <input
            className="input"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            style={{ fontSize: 13 }}
          />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label style={{ fontSize: 12 }}>Confirm password</label>
          <input
            className="input"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            style={{ fontSize: 13, borderColor: mismatch ? "var(--red, oklch(60% 0.2 25))" : undefined }}
          />
          {mismatch && <div style={{ fontSize: 12, color: "var(--red, oklch(60% 0.2 25))", marginTop: 4 }}>Passwords don&apos;t match</div>}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
          {status === "success" && <span className="chip ok"><Check style={{ width: 10, height: 10 }} /> Password updated</span>}
          {status === "error" && <span style={{ fontSize: 12, color: "var(--red, oklch(60% 0.2 25))" }}>{errorMsg}</span>}
          <button className="btn primary sm" type="submit" disabled={!canSubmit}>
            {status === "loading" ? <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} /> : <Save style={{ width: 12, height: 12 }} />}
            Update password
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Appearance tab ───────────────────────────────────────────────────────────

function AppearanceTab() {
  const { theme, density, setTheme, setDensity } = useTheme();
  return (
    <div className="p6-set">
      {/* 170px / 1fr labeled section (README). The segmented control writes
          data-theme + the lumi-theme localStorage key through the existing
          theme-provider — only the control's styling changed here. */}
      <div className="p6-set-row first">
        <div className="p6-set-label">Appearance</div>
        <div className="p6-set-body">
          <div>
            <div className="p6-field-note">Theme: applies immediately, saved per person</div>
            <div className="seg-ctrl">
              <SegBtn active={theme === "light"} onClick={() => setTheme("light")} icon={<Sun />} label="Light" />
              <SegBtn active={theme === "dark"} onClick={() => setTheme("dark")} icon={<Moon />} label="Dark" />
              <SegBtn active={theme === "system"} onClick={() => setTheme("system")} icon={<Monitor />} label="System" />
            </div>
          </div>
          <div>
            <div className="p6-field-note">Density: compact reduces spacing for information-dense views</div>
            <div className="seg-ctrl">
              <SegBtn active={density === "default"} onClick={() => setDensity("default")} icon={<AlignJustify />} label="Default" />
              <SegBtn active={density === "compact"} onClick={() => setDensity("compact")} icon={<Rows3 />} label="Compact" />
            </div>
          </div>
        </div>
      </div>
      <div className="p6-set-row last">
        <div className="p6-set-label">About</div>
        <div className="p6-set-body" style={{ gap: 10 }}>
          <AboutRow label="Platform" value="LumiAgents · Internal ops dashboard" />
          <AboutRow label="Runtime" value="Cloudflare Workers + Workflows" />
          <AboutRow label="Data layer" value="Supabase (Postgres + RLS)" />
        </div>
      </div>
    </div>
  );
}

function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, fontSize: 13 }}>
      <span style={{ color: "var(--color-neutral-400)" }}>{label}</span>
      <span style={{ color: "var(--color-neutral-200)" }}>{value}</span>
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
