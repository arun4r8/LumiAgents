"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Clock, ArrowRight, Play, X, Loader2, Check, AlertTriangle, ChevronDown } from "lucide-react";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  nullable?: boolean;
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
}

interface RunResult {
  runId: string;
  status: string;
  error?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OrchestrationsClient({ orchestrations }: { orchestrations: Orchestration[] }) {
  const [catalogue, setCatalogue] = useState<Map<string, CatalogueEntry>>(new Map());
  const [openForm, setOpenForm] = useState<string | null>(null); // orchestration name

  // Fetch live input schemas from the runtime catalogue
  useEffect(() => {
    fetch(`${RUNTIME}/api/orchestrations`)
      .then((r) => r.json())
      .then((data: CatalogueEntry[]) => {
        setCatalogue(new Map(data.map((e) => [e.name, e])));
      })
      .catch(() => {}); // silently degrade — forms just show no fields
  }, []);

  const active = orchestrations.filter((o) => o.is_active);

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Orchestrations</h1>
          <div className="sub">
            {orchestrations.length} catalogued · {active.length} active
          </div>
        </div>
      </div>

      {orchestrations.length === 0 ? (
        <div className="empty">
          <h4>No orchestrations registered yet.</h4>
          <p>Deploy the runtime and seed the orchestrations table.</p>
        </div>
      ) : (
        <div className="orch-grid">
          {orchestrations.map((o) => (
            <OrchCard
              key={o.id}
              orch={o}
              schema={catalogue.get(o.name)?.inputSchema ?? null}
              formOpen={openForm === o.name}
              onToggleForm={() => setOpenForm(openForm === o.name ? null : o.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function OrchCard({
  orch, schema, formOpen, onToggleForm,
}: {
  orch: Orchestration;
  schema: JsonSchema | null;
  formOpen: boolean;
  onToggleForm: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<RunResult | null>(null);

  const hasFields = schema?.properties && Object.keys(schema.properties).length > 0;

  async function triggerRun(e: React.FormEvent) {
    e.preventDefault();
    setPhase("running");
    setResult(null);

    // Build the payload — skip empty optional fields
    const required = new Set(schema?.required ?? []);
    const payload: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(values)) {
      if (val.trim()) {
        const prop = schema?.properties?.[key];
        payload[key] = prop?.type === "number" ? Number(val) : val.trim();
      }
    }

    // Check required fields
    for (const req of required) {
      if (!payload[req]) {
        setPhase("error");
        setResult({ runId: "", status: "error", error: `"${req}" is required` });
        return;
      }
    }

    try {
      const res = await fetch(`${RUNTIME}/api/orchestrations/${encodeURIComponent(orch.name)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    <div className={`orch-card${formOpen ? " expanded" : ""}`}>
      {/* ── Header ── */}
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div className="nm">{orch.name}</div>
        <span className={`chip ${orch.is_active ? "ok" : "muted"}`}>
          {orch.is_active ? "active" : "inactive"}
        </span>
      </div>

      {orch.description && <div className="desc">{orch.description}</div>}

      <div className="meta">
        <span className="chip muted mono" style={{ fontSize: 10.5 }}>v{orch.version}</span>
        {orch.cron && (
          <span className="chip accent">
            <Clock style={{ width: 10, height: 10 }} /> {orch.cron}
          </span>
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

        {orch.is_active && (
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
                        {prop.enum ? (
                          <select
                            className="sel"
                            style={{ height: 30, fontSize: 12.5 }}
                            value={values[key] ?? ""}
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
                            value={values[key] ?? ""}
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
        .run-form {
          margin-top: 14px;
          padding-top: 14px;
          border-top: 1px solid var(--line);
        }
        .run-result {
          display: flex; align-items: flex-start; gap: 8px;
          padding: 10px 12px; border-radius: 7px;
          font-size: 12.5px; margin-bottom: 12px;
        }
        .run-result.ok { background: var(--ok-soft, oklch(97% 0.02 145)); color: var(--ok); border: 1px solid oklch(88% 0.06 145); }
        .run-result.err { background: var(--err-soft); color: var(--err); border: 1px solid var(--err-line); }
      `}</style>
    </div>
  );
}
