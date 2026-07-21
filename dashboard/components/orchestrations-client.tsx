"use client";

import { useState, useEffect, useOptimistic, useTransition } from "react";
import Link from "next/link";
import { Clock, ArrowRight, Play, X, Loader2, Check, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  nullable?: boolean;
  format?: string; // "pdf-file" | "pdf-files" for upload inputs
}

// ─── PDF helpers ──────────────────────────────────────────────────────────────

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip "data:...;base64," prefix
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

interface CatalogueEntry {
  name: string;
  version: number;
  description: string | null;
  access: { triggerableBy: string[]; visibleTo: string[] };
  inputSchema: JsonSchema;
}

interface Orchestration {
  id: string;
  name: string;
  version: string | number;
  description: string | null;
  is_active: boolean;
  cron: string | null;
  trigger_mode: string;
}

interface RunResult {
  runId: string;
  status: string;
  error?: string;
}

// ─── Agent metadata ───────────────────────────────────────────────────────────

const AGENTS = [
  {
    id: "angie",
    label: "Angie",
    role: "HR & Recruiting",
    description: "Sources candidates via Apollo, scores them against job requirements, manages resume formatting, and drafts outreach — with a human approval gate before any message is sent.",
    color: "oklch(62% 0.18 280)",
    bg: "oklch(97% 0.03 280)",
  },
  {
    id: "beady",
    label: "Beady",
    role: "GovCon Business Development",
    description: "Monitors SAM.gov for federal opportunities, runs a 5-dimension go/no-go assessment against Lumiture's capabilities, and seeds past performance records into the RAG knowledge base.",
    color: "oklch(58% 0.17 145)",
    bg: "oklch(97% 0.03 145)",
  },
  {
    id: "money",
    label: "Money",
    role: "Finance & Analytics",
    description: "Answers natural language questions against financial data by generating and executing SQL, and produces multi-section executive reports.",
    color: "oklch(62% 0.16 85)",
    bg: "oklch(97% 0.03 85)",
  },
  {
    id: "patch",
    label: "Patch",
    role: "IT Operations & Knowledge",
    description: "Handles inbound triage, Jira ticket management, staff requests, vault sync from Obsidian, and document ingestion/retrieval from the RAG knowledge base.",
    color: "oklch(60% 0.16 30)",
    bg: "oklch(97% 0.03 30)",
  },
] as const;

// ─── Component ────────────────────────────────────────────────────────────────

export function OrchestrationsClient({
  orchestrations: initialOrchestrations,
  toggleOrchestration,
}: {
  orchestrations: Orchestration[];
  toggleOrchestration: (formData: FormData) => Promise<void>;
}) {
  const [catalogue, setCatalogue] = useState<Map<string, CatalogueEntry>>(new Map());
  const [openForm, setOpenForm] = useState<string | null>(null);
  const [orchestrations, setOptimisticOrchestrations] = useOptimistic(
    initialOrchestrations,
    (state, { id, is_active }: { id: string; is_active: boolean }) =>
      state.map((o) => (o.id === id ? { ...o, is_active } : o)),
  );

  useEffect(() => {
    fetch(`${RUNTIME}/api/orchestrations`)
      .then((r) => r.json())
      .then((data: CatalogueEntry[]) => setCatalogue(new Map(data.map((e) => [e.name, e]))))
      .catch(() => {});
  }, []);

  const scheduled = orchestrations.filter((o) => o.cron !== null);

  // Group orchestrations by agent prefix
  const byAgent = new Map<string, Orchestration[]>();
  for (const o of orchestrations) {
    const prefix = o.name.split("/")[0] ?? "other";
    if (!byAgent.has(prefix)) byAgent.set(prefix, []);
    byAgent.get(prefix)!.push(o);
  }

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Orchestrations</h1>
          <div className="sub">{orchestrations.length} capabilities · {scheduled.length} scheduled</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {AGENTS.map((agent) => {
            const agentOrch = byAgent.get(agent.id) ?? [];
            const scheduledCount = agentOrch.filter((o) => o.cron !== null).length;
            return (
              <AgentSection
                key={agent.id}
                agent={agent}
                orchestrations={agentOrch}
                scheduledCount={scheduledCount}
                catalogue={catalogue}
                openForm={openForm}
                setOpenForm={setOpenForm}
                toggleOrchestration={toggleOrchestration}
                onOptimisticToggle={(id, is_active) => setOptimisticOrchestrations({ id, is_active })}
              />
            );
          })}
        </div>
    </div>
  );
}

// ─── Agent section ────────────────────────────────────────────────────────────

function AgentSection({
  agent, orchestrations, scheduledCount, catalogue, openForm, setOpenForm,
  toggleOrchestration, onOptimisticToggle,
}: {
  agent: typeof AGENTS[number];
  orchestrations: Orchestration[];
  scheduledCount: number;
  catalogue: Map<string, CatalogueEntry>;
  openForm: string | null;
  setOpenForm: (name: string | null) => void;
  toggleOrchestration: (formData: FormData) => Promise<void>;
  onOptimisticToggle: (id: string, is_active: boolean) => void;
}) {
  return (
    <div>
      {/* Agent header */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 14,
        padding: "14px 18px", borderRadius: 0,
        background: agent.bg,
        border: `1px solid color-mix(in oklch, ${agent.color} 20%, transparent)`,
        marginBottom: 14,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 0, flexShrink: 0,
          background: agent.color, display: "flex", alignItems: "center",
          justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 16,
        }}>
          {agent.label[0]}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
            <span style={{ fontWeight: 700, fontSize: 15, color: agent.color }}>{agent.label}</span>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>·</span>
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{agent.role}</span>
            {scheduledCount > 0 && (
              <span className="chip muted" style={{ fontSize: 10.5, marginLeft: "auto" }}>
                {scheduledCount} scheduled
              </span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
            {agent.description}
          </div>
        </div>
      </div>

      {/* Capability cards */}
      {orchestrations.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5, padding: "10px 4px" }}>
          No capabilities registered yet — deploy the runtime to seed this agent&apos;s orchestrations.
        </div>
      ) : (
        <div className="orch-grid">
          {orchestrations.map((o) => (
            <OrchCard
              key={o.id}
              orch={o}
              agentColor={agent.color}
              schema={catalogue.get(o.name)?.inputSchema ?? null}
              formOpen={openForm === o.name}
              onToggleForm={() => setOpenForm(openForm === o.name ? null : o.name)}
              toggleOrchestration={toggleOrchestration}
              onOptimisticToggle={(is_active) => onOptimisticToggle(o.id, is_active)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function OrchCard({
  orch, agentColor, schema, formOpen, onToggleForm, toggleOrchestration, onOptimisticToggle,
}: {
  orch: Orchestration;
  agentColor: string;
  schema: JsonSchema | null;
  formOpen: boolean;
  onToggleForm: () => void;
  toggleOrchestration: (formData: FormData) => Promise<void>;
  onOptimisticToggle: (is_active: boolean) => void;
}) {
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<RunResult | null>(null);
  const [, startTransition] = useTransition();

  const hasFields = schema?.properties && Object.keys(schema.properties).length > 0;

  // Show just the capability slug, not the full "agent/slug"
  const capabilityName = orch.name.split("/").slice(1).join("/").replace(/-/g, " ");

  async function triggerRun(e: React.FormEvent) {
    e.preventDefault();
    setPhase("running");
    setResult(null);

    const required = new Set(schema?.required ?? []);
    const payload: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(values)) {
      if (Array.isArray(val)) {
        if (val.length > 0) payload[key] = val;
      } else if (val.trim()) {
        const prop = schema?.properties?.[key];
        payload[key] = prop?.type === "number" ? Number(val) : val.trim();
      }
    }

    for (const req of required) {
      if (!payload[req]) {
        setPhase("error");
        setResult({ runId: "", status: "error", error: `"${req}" is required` });
        return;
      }
    }

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${RUNTIME}/api/orchestrations/${encodeURIComponent(orch.name)}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify(Object.keys(payload).length > 0 ? payload : {}),
      });

      const data = await res.json() as RunResult & { error?: string };

      if (!res.ok) {
        setPhase("error");
        setResult({ runId: "", status: "error", error: data.error ?? `HTTP ${res.status}` });
        return;
      }

      setPhase("done");
      setResult(data);
      setValues({});
    } catch (err) {
      setPhase("error");
      setResult({ runId: "", status: "error", error: err instanceof Error ? err.message : "Network error" });
    }
  }

  function reset() {
    setPhase("idle");
    setResult(null);
    setValues({});
    onToggleForm();
  }

  return (
    <div className={`orch-card${formOpen ? " expanded" : ""}${orch.cron && !orch.is_active ? " inactive" : ""}`}>
      {/* ── Header ── */}
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="nm" style={{ textTransform: "capitalize" }}>{capabilityName}</div>
          <code style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono, monospace)" }}>
            {orch.name}
          </code>
        </div>
        {orch.cron && (
          <form
            action={(fd) => {
              startTransition(async () => {
                onOptimisticToggle(!orch.is_active);
                await toggleOrchestration(fd);
              });
            }}
            style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}
          >
            <input type="hidden" name="id" value={orch.id} />
            <input type="hidden" name="is_active" value={String(orch.is_active)} />
            <button
              type="submit"
              title={orch.is_active ? "Pause schedule" : "Resume schedule"}
              style={{
                width: 34, height: 20, borderRadius: 0, border: "none",
                cursor: "pointer", padding: 0, flexShrink: 0,
                background: orch.is_active ? agentColor : "var(--ink-4, #ccc)",
                position: "relative", transition: "background 0.2s",
              }}
            >
              <span style={{
                position: "absolute", top: 2, left: orch.is_active ? 16 : 2,
                width: 16, height: 16, borderRadius: "50%", background: "#fff",
                transition: "left 0.2s",
              }} />
            </button>
          </form>
        )}
      </div>

      {orch.description && <div className="desc">{orch.description}</div>}

      <div className="meta">
        <span className="chip muted mono" style={{ fontSize: 10.5 }}>v{orch.version}</span>
        {orch.cron && (
          <span className="chip" style={{ fontSize: 10.5, background: `color-mix(in oklch, ${agentColor} 12%, transparent)`, color: agentColor }}>
            <Clock style={{ width: 10, height: 10 }} /> {orch.cron}
          </span>
        )}
        {orch.cron && !orch.is_active && (
          <span className="chip muted" style={{ fontSize: 10.5 }}>schedule paused</span>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="ft">
        <Link
          href={`/runs?orchestration=${encodeURIComponent(orch.name)}`}
          className="row gap-sm"
          style={{ fontSize: 12.5, color: "var(--ink-3)" }}
        >
          View runs <ArrowRight style={{ width: 12, height: 12 }} />
        </Link>

        {orch.trigger_mode === "agent" ? (
          <Link
            href={`/agents/${orch.name.split("/")[0]}`}
            className="btn sm"
            style={{ fontSize: 11.5 }}
          >
            Chat with {orch.name.split("/")[0]?.charAt(0).toUpperCase()}{orch.name.split("/")[0]?.slice(1)}
          </Link>
        ) : (
          <button
            className={`btn sm${formOpen ? "" : " accent"}`}
            onClick={formOpen && phase !== "idle" ? reset : onToggleForm}
          >
            {formOpen ? (
              <><X style={{ width: 11, height: 11 }} /> Close</>
            ) : (
              <><Play style={{ width: 11, height: 11 }} /> Run</>
            )}
          </button>
        )}
      </div>

      {/* ── Run form ── */}
      {formOpen && (
        <div className="run-form">
          {phase === "done" && result ? (
            <div className="run-result ok">
              <Check style={{ width: 13, height: 13 }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>Run started</div>
                <div style={{ fontSize: 12, marginTop: 2 }}>
                  <Link
                    href={`/runs/${result.runId}`}
                    style={{ color: "var(--accent)", textDecoration: "underline" }}
                  >
                    View run →
                  </Link>
                </div>
              </div>
            </div>
          ) : phase === "error" && result ? (
            <div className="run-result err">
              <AlertTriangle style={{ width: 13, height: 13, flexShrink: 0 }} />
              <span>{result.error}</span>
            </div>
          ) : null}

          {(phase === "idle" || phase === "error" || phase === "running") && (
            <form onSubmit={triggerRun}>
              {hasFields ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
                  {Object.entries(schema!.properties!).map(([key, prop]) => {
                    const isRequired = schema?.required?.includes(key);
                    return (
                      <div key={key} className="field" style={{ margin: 0 }}>
                        <label style={{ fontSize: 11.5 }}>
                          {key.replace(/_/g, " ")}
                          {isRequired && <span style={{ color: "var(--err)" }}> *</span>}
                          {prop.description && (
                            <span style={{ color: "var(--ink-3)", fontWeight: 400, marginLeft: 4 }}>
                              — {prop.description}
                            </span>
                          )}
                        </label>
                        {prop.format === "pdf-files" ? (
                          <div>
                            <input
                              type="file"
                              accept=".pdf,.docx,.rtf,.txt,.md,.csv,.jpg,.jpeg,.png"
                              multiple
                              style={{ fontSize: 12, display: "block" }}
                              onChange={async (e) => {
                                const files = Array.from(e.target.files ?? []);
                                const b64s = await Promise.all(files.map(fileToBase64));
                                setValues((v) => ({ ...v, [key]: b64s }));
                              }}
                            />
                            {Array.isArray(values[key]) && (values[key] as string[]).length > 0 && (
                              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 3 }}>
                                {(values[key] as string[]).length} file(s) ready · batch · auto-converted to PDF
                              </div>
                            )}
                          </div>
                        ) : prop.format === "pdf-file" ? (
                          <div>
                            <input
                              type="file"
                              accept=".pdf,.docx,.rtf,.txt,.md,.csv,.jpg,.jpeg,.png"
                              style={{ fontSize: 12, display: "block" }}
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                const b64 = await fileToBase64(file);
                                setValues((v) => ({ ...v, [key]: b64 }));
                              }}
                            />
                            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 3 }}>
                              PDF, DOCX, RTF, TXT, images · single file · auto-converted to PDF
                            </div>
                          </div>
                        ) : prop.enum ? (
                          <select
                            className="sel"
                            style={{ height: 30, fontSize: 12.5 }}
                            value={(values[key] as string) ?? ""}
                            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                          >
                            <option value="">—</option>
                            {prop.enum.map((opt) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className="input"
                            style={{ height: 30, fontSize: 12.5 }}
                            type={prop.type === "number" ? "number" : "text"}
                            placeholder={prop.description ?? key}
                            value={(values[key] as string) ?? ""}
                            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginBottom: 12 }}>
                  No inputs required — this orchestration runs with defaults.
                </div>
              )}

              <button
                type="submit"
                className="btn accent sm"
                disabled={phase === "running"}
                style={{ width: "100%", justifyContent: "center" }}
              >
                {phase === "running" ? (
                  <><Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} /> Starting…</>
                ) : (
                  <><Play style={{ width: 12, height: 12 }} /> Trigger run</>
                )}
              </button>
            </form>
          )}
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .orch-card.expanded { border-color: var(--accent); }
        .orch-card.inactive { opacity: 0.6; }
        .run-form {
          margin-top: 14px;
          padding-top: 14px;
          border-top: 1px solid var(--line);
        }
        .run-result {
          display: flex; align-items: flex-start; gap: 8px;
          padding: 10px 12px; border-radius: 0;
          font-size: 12.5px; margin-bottom: 12px;
        }
        .run-result.ok { background: var(--ok-soft, oklch(97% 0.02 145)); color: var(--ok); border: 1px solid oklch(88% 0.06 145); }
        .run-result.err { background: var(--err-soft); color: var(--err); border: 1px solid var(--err-line); }
      `}</style>
    </div>
  );
}
