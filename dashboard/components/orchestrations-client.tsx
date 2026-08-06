"use client";

import { useState, useEffect, useOptimistic, useTransition } from "react";
import Link from "next/link";
import { Clock, ArrowRight, Play, X, Loader2, Check, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { AgentMark } from "@/components/agent-mark";
import { agentColor, agentSoft } from "@/lib/agent-style";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "";

// Map a raw runtime failure to a friendly, user-safe message. The real error is
// kept in console.error for debugging; endusers never see raw runtime strings.
function friendlyRuntimeError(status: number | null, rawError: unknown): string {
  console.error("[orchestrations] run failed:", status, rawError);
  const msg = rawError instanceof Error ? rawError.message : String(rawError ?? "");
  if (status === 403 || /\b403\b|forbidden/i.test(msg)) {
    return "You don't have access to this yet. Ask an ops admin.";
  }
  return "Something went wrong. Try again.";
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  nullable?: boolean;
  format?: string; // "pdf-file" | "pdf-files" for upload inputs
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchemaProperty;
}

// A z.discriminatedUnion arrives as one variant per discriminator value; the form
// renders a selector for the discriminator and swaps the field set beneath it.
interface JsonSchemaVariant {
  value: string;
  description?: string;
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  discriminator?: string;
  variants?: JsonSchemaVariant[];
}

type FieldValue = string | string[] | boolean;

// ─── Schema → form helpers ────────────────────────────────────────────────────

// Domain shorthand that reads wrong in sentence case ("Sam limit", "Jql").
const ACRONYMS = new Set([
  "ai", "api", "csv", "hr", "id", "ids", "it", "jd", "jql", "naics",
  "pdf", "pdfs", "rag", "rfi", "sam", "sbir", "sql", "url", "uuid",
]);

/**
 * "maxCandidates" → "Max candidates", "posted_within_days" → "Posted within days",
 * "samLimit" → "SAM limit". Property keys are overwhelmingly camelCase, so splitting
 * on underscores alone (the old behaviour) left them unreadable.
 */
function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // PDFBase → PDF Base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // maxCandidates → max Candidates
    .toLowerCase()
    .split(" ")
    .filter(Boolean);

  return words
    .map((word, i) => {
      if (ACRONYMS.has(word)) return word.toUpperCase();
      return i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}

/**
 * Pull a placeholder out of an "e.g. …" example in the description, e.g.
 * "Ticket to update (e.g. OPS-42)" → "OPS-42". Only literal-looking examples are
 * used (quoted, bracketed, or a single token); prose like "e.g. 24 for today's
 * batch" is not a value a user could type, so it gets no placeholder. There is
 * deliberately no fallback to the raw key.
 */
function placeholderFrom(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const match = /e\.g\.?\s*(.+?)(?:\)|\.\s|\.$|$)/i.exec(description);
  if (!match?.[1]) return undefined;

  const example = match[1].trim().replace(/^\[/, "").replace(/\]$/, "");
  const first = (example.split(/,\s*(?=['"[])/)[0] ?? example).trim();
  const quoted = /^(['"])(.*)\1$/.exec(first);
  if (quoted?.[2]) return quoted[2];
  // Unquoted: only trust single tokens ("OPS-42"), never a prose fragment.
  return first.includes(" ") ? undefined : first || undefined;
}

function isNumeric(prop: JsonSchemaProperty): boolean {
  return prop.type === "number" || prop.type === "integer";
}

function isStringArray(prop: JsonSchemaProperty): boolean {
  return prop.type === "array" && (prop.items?.type ?? "string") === "string";
}

// Turn a schema `default` into the value the widget holds.
function defaultFieldValue(prop: JsonSchemaProperty): FieldValue | undefined {
  const value = prop.default;
  if (value === undefined) return prop.type === "boolean" ? false : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "number" || typeof value === "string") return String(value);
  return undefined;
}

function formatDefault(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

// "optional · default 10 · 1–25" — the metadata that used to be invisible.
function fieldHints(prop: JsonSchemaProperty, isRequired: boolean): string[] {
  const hints: string[] = [];
  if (!isRequired) hints.push("optional");
  if (prop.default !== undefined) hints.push(`default ${formatDefault(prop.default)}`);
  if (isNumeric(prop)) {
    if (prop.minimum !== undefined && prop.maximum !== undefined) hints.push(`${prop.minimum}–${prop.maximum}`);
    else if (prop.minimum !== undefined) hints.push(`min ${prop.minimum}`);
    else if (prop.maximum !== undefined) hints.push(`max ${prop.maximum}`);
  } else if (prop.type === "string" && prop.minLength !== undefined && prop.minLength > 1) {
    hints.push(`min ${prop.minLength} characters`);
  }
  return hints;
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

interface AgentMeta {
  id: string;
  label: string;
  role: string;
  description: string;
  color: string;
  bg: string;
}

// Presentation only. The list of sections rendered is derived from the data, so an
// agent missing from this map still gets a section (see agentMetaFor).
const AGENT_META: Record<string, Omit<AgentMeta, "id">> = {
  angie: {
    label: "Angie",
    role: "HR & Recruiting",
    description: "Sources candidates via Apollo, scores them against job requirements, manages resume formatting, and drafts outreach, with a human approval gate before any message is sent.",
    color: agentColor("angie"),
    bg: agentSoft("angie"),
  },
  beady: {
    label: "Beady",
    role: "GovCon Business Development",
    description: "Monitors SAM.gov for federal opportunities, runs a 5-dimension go/no-go assessment against Lumiture's capabilities, and seeds past performance records into the RAG knowledge base.",
    color: agentColor("beady"),
    bg: agentSoft("beady"),
  },
  cleo: {
    label: "Cleo",
    role: "Eminence, Awards & Proposals",
    description: "Sweeps industry and government award programmes, scores them on fit and effort, and plans and drafts the eminence content calendar for human review before anything is posted.",
    color: "oklch(62% 0.17 320)",
    bg: "oklch(97% 0.03 320)",
  },
  dewey: {
    label: "Dewey",
    role: "Knowledge Librarian",
    description: "Steward of the shared knowledge base: answers questions with citations, keeps an inventory of what the team knows, and curates each document's corpus and sensitivity tags.",
    color: "oklch(60% 0.15 230)",
    bg: "oklch(97% 0.03 230)",
  },
  money: {
    label: "Money",
    role: "Finance & Analytics",
    description: "Answers natural language questions against financial data by generating and executing SQL, and produces multi-section executive reports.",
    color: agentColor("money"),
    bg: agentSoft("money"),
  },
  patch: {
    label: "Patch",
    role: "IT Operations & Knowledge",
    description: "Handles inbound triage, Jira ticket management, staff requests, vault sync from Obsidian, and document ingestion/retrieval from the RAG knowledge base.",
    color: agentColor("patch"),
    bg: agentSoft("patch"),
  },
  system: {
    label: "System",
    role: "Platform Maintenance",
    description: "Housekeeping the platform runs on itself: retention sweeps over conversations, messages, and memory chunks.",
    color: "oklch(55% 0.03 260)",
    bg: "oklch(97% 0.01 260)",
  },
};

// Agents get a stable preferred order; anything new appears after it alphabetically.
const AGENT_ORDER = ["angie", "beady", "cleo", "dewey", "money", "patch", "system"];

function agentMetaFor(id: string): AgentMeta {
  const meta = AGENT_META[id];
  if (meta) return { id, ...meta };
  return {
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    role: "",
    description: "",
    color: "var(--accent)",
    bg: "var(--bg-2)",
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OrchestrationsClient({
  orchestrations: initialOrchestrations,
  toggleOrchestration,
  isOps = false,
}: {
  orchestrations: Orchestration[];
  toggleOrchestration: (formData: FormData) => Promise<void>;
  isOps?: boolean;
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

  // Derived from the data, not a hardcoded list — otherwise a whole agent's
  // orchestrations are grouped and then silently never rendered (#128).
  const agentIds = [
    ...AGENT_ORDER.filter((id) => byAgent.has(id)),
    ...[...byAgent.keys()].filter((id) => !AGENT_ORDER.includes(id)).sort(),
  ];

  return (
    <div className="page view-fade">
      <h1 className="p6-h1">Orchestrations</h1>
      <div className="p6-sub">{orchestrations.length} registered · trigger ad-hoc runs or wire a schedule · {scheduled.length} scheduled</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {agentIds.map((agentId) => {
            const agentOrch = byAgent.get(agentId) ?? [];
            const scheduledCount = agentOrch.filter((o) => o.cron !== null).length;
            return (
              <AgentSection
                key={agentId}
                agent={agentMetaFor(agentId)}
                orchestrations={agentOrch}
                scheduledCount={scheduledCount}
                catalogue={catalogue}
                openForm={openForm}
                setOpenForm={setOpenForm}
                toggleOrchestration={toggleOrchestration}
                isOps={isOps}
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
  toggleOrchestration, onOptimisticToggle, isOps,
}: {
  agent: AgentMeta;
  orchestrations: Orchestration[];
  scheduledCount: number;
  catalogue: Map<string, CatalogueEntry>;
  openForm: string | null;
  setOpenForm: (name: string | null) => void;
  toggleOrchestration: (formData: FormData) => Promise<void>;
  onOptimisticToggle: (id: string, is_active: boolean) => void;
  isOps: boolean;
}) {
  return (
    <div>
      {/* Agent header — tonal surface + letter-mark identity */}
      <div className="p6-agent-head">
        <AgentMark slug={agent.id} name={agent.label} size={44} />
        <div className="p6-agent-head-main">
          <div className="p6-agent-head-top">
            {/* weight 500: the redesign loads Inter at 400/500/600 only, so 700
                would render as synthesized faux-bold. role is optional because
                agents discovered from the data (cleo/dewey/system) may have none. */}
            <span className="p6-agent-name">{agent.label}</span>
            {agent.role && (
              <>
                <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>·</span>
                <span className="p6-agent-role">{agent.role}</span>
              </>
            )}
            {scheduledCount > 0 && (
              <span className="tag tag-neutral" style={{ marginLeft: "auto" }}>
                {scheduledCount} scheduled
              </span>
            )}
          </div>
          {agent.description && (
            <div className="p6-agent-desc">{agent.description}</div>
          )}
        </div>
      </div>

      {/* Capability cards */}
      {orchestrations.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5, padding: "10px 4px" }}>
          No capabilities registered yet. Deploy the runtime to seed this agent&apos;s orchestrations.
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
              isOps={isOps}
              onOptimisticToggle={(is_active) => onOptimisticToggle(o.id, is_active)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Widgets ──────────────────────────────────────────────────────────────────

/** Chip input for string arrays. Commit with Enter or comma; Backspace pops. */
function TagInput({
  id, value, placeholder, onChange,
}: {
  id: string;
  value: string[];
  placeholder: string | undefined;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const part of parts) if (!next.includes(part)) next.push(part);
    onChange(next);
    setDraft("");
  }

  return (
    <div className="tag-input">
      {value.map((tag) => (
        <span key={tag} className="tag">
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => onChange(value.filter((t) => t !== tag))}
          >
            <X style={{ width: 9, height: 9 }} />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        placeholder={value.length === 0 ? (placeholder ?? "Add a value, then press Enter") : "Add another…"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

function Field({
  fieldId, propKey, prop, isRequired, value, onChange,
}: {
  fieldId: string;
  propKey: string;
  prop: JsonSchemaProperty;
  isRequired: boolean;
  value: FieldValue | undefined;
  onChange: (next: FieldValue) => void;
}) {
  const isUpload = prop.format === "pdf-file" || prop.format === "pdf-files";
  // An upload field is a file picker, so the base64 transport detail in its key is noise.
  const label = humanizeKey(isUpload ? propKey.replace(/base64s?$/i, "") : propKey);
  const hints = fieldHints(prop, isRequired);
  const placeholder = placeholderFrom(prop.description);

  // A checkbox carries its own inline label, so the block label is skipped for it.
  const isCheckbox = prop.type === "boolean";

  const control = (() => {
    if (prop.format === "pdf-files") {
      const files = Array.isArray(value) ? value : [];
      return (
        <div>
          <input
            id={fieldId}
            type="file"
            accept=".pdf,.docx,.rtf,.txt,.md,.csv,.jpg,.jpeg,.png"
            multiple
            style={{ fontSize: 12, display: "block" }}
            onChange={async (e) => {
              const picked = Array.from(e.target.files ?? []);
              onChange(await Promise.all(picked.map(fileToBase64)));
            }}
          />
          {files.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 3 }}>
              {files.length} file(s) ready · batch · auto-converted to PDF
            </div>
          )}
        </div>
      );
    }

    if (prop.format === "pdf-file") {
      return (
        <div>
          <input
            id={fieldId}
            type="file"
            accept=".pdf,.docx,.rtf,.txt,.md,.csv,.jpg,.jpeg,.png"
            style={{ fontSize: 12, display: "block" }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              onChange(await fileToBase64(file));
            }}
          />
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 3 }}>
            PDF, DOCX, RTF, TXT, images · single file · auto-converted to PDF
          </div>
        </div>
      );
    }

    if (prop.enum) {
      return (
        <select
          id={fieldId}
          className="sel"
          style={{ height: 30, fontSize: 12.5 }}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {!isRequired && prop.default === undefined && <option value="">-</option>}
          {prop.enum.map((opt) => (
            <option key={opt} value={opt}>{humanizeKey(opt)}</option>
          ))}
        </select>
      );
    }

    if (isCheckbox) {
      return (
        <label className="check-row" htmlFor={fieldId}>
          <input
            id={fieldId}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>
            {label}
            {isRequired && <span style={{ color: "var(--err)" }}> *</span>}
          </span>
        </label>
      );
    }

    if (isStringArray(prop)) {
      return (
        <TagInput
          id={fieldId}
          value={Array.isArray(value) ? value : []}
          placeholder={placeholder}
          onChange={onChange}
        />
      );
    }

    return (
      <input
        id={fieldId}
        className="input"
        style={{ height: 30, fontSize: 12.5 }}
        type={isNumeric(prop) ? "number" : "text"}
        {...(isNumeric(prop) && prop.minimum !== undefined ? { min: prop.minimum } : {})}
        {...(isNumeric(prop) && prop.maximum !== undefined ? { max: prop.maximum } : {})}
        {...(placeholder !== undefined ? { placeholder } : {})}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  })();

  return (
    <div className="field" style={{ margin: 0 }}>
      {!isCheckbox && (
        <label style={{ fontSize: 11.5 }} htmlFor={fieldId}>
          {label}
          {isRequired && <span style={{ color: "var(--err)" }}> *</span>}
          {hints.length > 0 && (
            <span style={{ color: "var(--ink-4)", fontWeight: 400, marginLeft: 6, textTransform: "none" }}>
              {hints.join(" · ")}
            </span>
          )}
        </label>
      )}
      {/* Help text sits under the label, not squeezed into parentheses beside it. */}
      {prop.description && (
        <div className="field-help">{prop.description}</div>
      )}
      {control}
      {isCheckbox && hints.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 2 }}>{hints.join(" · ")}</div>
      )}
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function OrchCard({
  orch, agentColor, schema, formOpen, onToggleForm, toggleOrchestration, onOptimisticToggle, isOps,
}: {
  orch: Orchestration;
  agentColor: string;
  schema: JsonSchema | null;
  formOpen: boolean;
  onToggleForm: () => void;
  toggleOrchestration: (formData: FormData) => Promise<void>;
  onOptimisticToggle: (is_active: boolean) => void;
  isOps: boolean;
}) {
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [variant, setVariant] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<RunResult | null>(null);
  const [, startTransition] = useTransition();

  const discriminator = schema?.discriminator;
  const variants = schema?.variants;

  const activeVariant = variants && variants.length > 0
    ? variants.find((v) => v.value === variant) ?? variants[0] ?? null
    : null;

  const properties: Record<string, JsonSchemaProperty> =
    activeVariant ? activeVariant.properties : schema?.properties ?? {};
  const required: string[] = activeVariant ? activeVariant.required : schema?.required ?? [];

  // Untouched fields fall back to their declared default (and booleans to false), so
  // defaults are visible in the widget and submitted without the user retyping them.
  function valueFor(key: string, prop: JsonSchemaProperty): FieldValue | undefined {
    return values[key] !== undefined ? values[key] : defaultFieldValue(prop);
  }

  const hasFields = Object.keys(properties).length > 0 || Boolean(discriminator);

  // Show just the capability slug, not the full "agent/slug"
  const capabilityName = orch.name.split("/").slice(1).join("/").replace(/-/g, " ");

  function buildPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (discriminator && activeVariant) payload[discriminator] = activeVariant.value;

    for (const [key, prop] of Object.entries(properties)) {
      const val = valueFor(key, prop);
      if (val === undefined) continue;
      if (typeof val === "boolean") {
        payload[key] = val;
      } else if (Array.isArray(val)) {
        if (val.length > 0) payload[key] = val;
      } else if (val.trim()) {
        payload[key] = isNumeric(prop) ? Number(val) : val.trim();
      }
    }
    return payload;
  }

  async function triggerRun(e: React.FormEvent) {
    e.preventDefault();
    setPhase("running");
    setResult(null);

    const payload = buildPayload();

    for (const req of required) {
      const val = payload[req];
      if (val === undefined || val === "" || (Array.isArray(val) && val.length === 0)) {
        setPhase("error");
        setResult({ runId: "", status: "error", error: `"${humanizeKey(req)}" is required` });
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
        body: JSON.stringify(payload),
      });

      const data = await res.json() as RunResult & { error?: string };

      if (!res.ok) {
        setPhase("error");
        setResult({ runId: "", status: "error", error: friendlyRuntimeError(res.status, data.error) });
        return;
      }

      setPhase("done");
      setResult(data);
      setValues({});
    } catch (err) {
      setPhase("error");
      setResult({ runId: "", status: "error", error: friendlyRuntimeError(null, err) });
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
        {/* Pausing a schedule is an ops-only UPDATE under RLS, so the toggle is hidden
            from endusers rather than optimistically flipping and silently reverting. */}
        {orch.cron && isOps && (
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
                width: 34, height: 20, borderRadius: 10, border: "none",
                cursor: "pointer", padding: 0, flexShrink: 0,
                background: orch.is_active ? agentColor : "var(--color-neutral-600)",
                position: "relative", transition: "background 0.2s",
              }}
            >
              <span style={{
                position: "absolute", top: 2, left: orch.is_active ? 16 : 2,
                width: 16, height: 16, borderRadius: "50%", background: "var(--color-neutral-100)",
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
            className={`btn sm${formOpen ? "" : " primary"}`}
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
                  {discriminator && variants && variants.length > 0 && (
                    <div className="field" style={{ margin: 0 }}>
                      <label style={{ fontSize: 11.5 }} htmlFor={`${orch.id}-${discriminator}`}>
                        {humanizeKey(discriminator)}
                        <span style={{ color: "var(--err)" }}> *</span>
                      </label>
                      <div className="field-help">
                        Pick what this run should do; the fields below change to match.
                      </div>
                      <select
                        id={`${orch.id}-${discriminator}`}
                        className="sel"
                        style={{ height: 30, fontSize: 12.5 }}
                        value={activeVariant?.value ?? ""}
                        onChange={(e) => {
                          setVariant(e.target.value);
                          setValues({});
                        }}
                      >
                        {variants.map((v) => (
                          <option key={v.value} value={v.value}>{humanizeKey(v.value)}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {Object.entries(properties).map(([key, prop]) => (
                    <Field
                      key={key}
                      fieldId={`${orch.id}-${activeVariant?.value ?? "_"}-${key}`}
                      propKey={key}
                      prop={prop}
                      isRequired={required.includes(key)}
                      value={valueFor(key, prop)}
                      onChange={(next) => setValues((v) => ({ ...v, [key]: next }))}
                    />
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginBottom: 12 }}>
                  No inputs required; this orchestration runs with defaults.
                </div>
              )}

              <button
                type="submit"
                className="btn primary sm"
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
        .run-form .field-help {
          font-size: 11.5px;
          line-height: 1.45;
          color: var(--ink-3);
          margin: 2px 0 5px;
          text-transform: none;
          font-weight: 400;
        }
        .run-form .check-row {
          display: flex; align-items: center; gap: 7px;
          font-size: 12.5px; text-transform: none; font-weight: 500;
          cursor: pointer; margin: 0;
        }
        .run-form .check-row input { width: 14px; height: 14px; margin: 0; cursor: pointer; }
        .run-form .tag-input {
          display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
          min-height: 30px; padding: 3px 6px;
          border: 1px solid var(--line-2); background: var(--bg);
          border-radius: var(--radius-md);
        }
        .run-form .tag-input input {
          flex: 1; min-width: 90px; border: none; outline: none;
          background: transparent; font-size: 12.5px; height: 22px; color: inherit;
        }
        .run-form .tag {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 1px 5px; font-size: 11.5px;
          background: var(--bg-2); border: 1px solid var(--line-2);
          border-radius: var(--radius-sm);
        }
        .run-form .tag button {
          border: none; background: none; padding: 0; cursor: pointer;
          display: flex; align-items: center; color: var(--ink-3);
        }
        .run-result {
          display: flex; align-items: flex-start; gap: 8px;
          padding: 10px 12px; border-radius: var(--radius-md);
          font-size: 12.5px; margin-bottom: 12px;
        }
        .run-result.ok { background: var(--ok-soft); color: var(--ok); border: 1px solid var(--ok-line); }
        .run-result.err { background: var(--err-soft); color: var(--err); border: 1px solid var(--err-line); }
      `}</style>
    </div>
  );
}
