"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  SlidersHorizontal, X, Save, Check, Loader2, History, RotateCcw, MessageSquare,
} from "lucide-react";
import {
  validateOverride,
  MAX_TOKENS_MIN,
  MAX_TOKENS_MAX,
  SYSTEM_PROMPT_MAX,
  type OverrideDraft,
  type PromptStrategy,
  type SaveResult,
} from "@/lib/agent-overrides";

// Tier 0 "Customize agent" panel (#67). Ops-only — the parent page renders it only for ops,
// and both server actions re-check ops + RLS. Edits persona (append/replace), model,
// max_tokens, and the enabled-tool subset; they take effect on the agent's next chat turn.

interface HistoryRow {
  id: string;
  prompt_strategy: PromptStrategy;
  system_prompt: string | null;
  enabled_tools: string[] | null;
  created_at: string;
}

interface CurrentState {
  system_prompt: string | null;
  prompt_strategy: PromptStrategy;
  enabled_tools: string[] | null;
  model: string;
  max_tokens: number;
  updated_at: string | null;
}

interface Props {
  slug: string;
  displayName: string;
  basePrompt: string;
  tools: { name: string; description: string }[];
  allowedModels: readonly string[];
  current: CurrentState;
  history: HistoryRow[];
  saveAgentOverrides: (slug: string, draft: OverrideDraft) => Promise<SaveResult>;
  revertAgentOverride: (slug: string, overrideId: string) => Promise<SaveResult>;
}

const LABEL: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: "var(--ink-3)",
  textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6,
};

export default function CustomizeAgentPanel(props: Props) {
  const { slug, displayName, basePrompt, tools, allowedModels, current, history } = props;
  const router = useRouter();
  const allToolNames = useMemo(() => tools.map((t) => t.name), [tools]);

  const [open, setOpen] = useState(false);

  // Draft state, seeded from the current effective override.
  const [strategy, setStrategy] = useState<PromptStrategy>(current.prompt_strategy);
  const [prompt, setPrompt] = useState(current.system_prompt ?? "");
  const [model, setModel] = useState(current.model);
  const [maxTokens, setMaxTokens] = useState(current.max_tokens);
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(current.enabled_tools ?? allToolNames),
  );

  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // null when every tool is enabled ("all"); otherwise the explicit subset.
  const enabledTools: string[] | null = useMemo(() => {
    const list = allToolNames.filter((n) => enabled.has(n));
    return list.length === allToolNames.length ? null : list;
  }, [enabled, allToolNames]);

  const draft: OverrideDraft = {
    system_prompt: prompt.trim() ? prompt : null,
    prompt_strategy: strategy,
    enabled_tools: enabledTools,
    model,
    max_tokens: maxTokens,
  };

  const liveErrors = validateOverride(draft, allToolNames);
  const hasErrors = Object.keys(liveErrors).length > 0;

  function switchStrategy(next: PromptStrategy) {
    // Convenience: switching to "replace" from an empty prompt seeds the base so the ops
    // user edits a full prompt rather than starting from nothing.
    if (next === "replace" && prompt.trim().length === 0) setPrompt(basePrompt);
    setStrategy(next);
  }

  function toggleTool(name: string) {
    setEnabled((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(name)) nextSet.delete(name);
      else nextSet.add(name);
      return nextSet;
    });
  }

  function save() {
    setErrors({});
    setSaved(false);
    startTransition(async () => {
      const res = await props.saveAgentOverrides(slug, draft);
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
        router.refresh();
      } else {
        setErrors(res.errors);
      }
    });
  }

  function revert(id: string) {
    setErrors({});
    startTransition(async () => {
      const res = await props.revertAgentOverride(slug, id);
      if (res.ok) router.refresh();
      else setErrors(res.errors);
    });
  }

  if (!open) {
    return (
      <div style={{ marginTop: 16, display: "flex", justifyContent: "center" }}>
        <button className="btn sm" type="button" onClick={() => setOpen(true)}>
          <SlidersHorizontal style={{ width: 13, height: 13 }} /> Customize {displayName}
        </button>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 16, padding: 0, overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "12px 18px",
        borderBottom: "1px solid var(--line)", background: "var(--bg-1, var(--bg-2))",
      }}>
        <SlidersHorizontal style={{ width: 15, height: 15, color: "var(--accent)" }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Customize {displayName}</div>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            Ops-only. Persona, model, and enabled tools. No code deploy.
          </div>
        </div>
        <button className="btn sm" type="button" onClick={() => setOpen(false)} aria-label="Close">
          <X style={{ width: 13, height: 13 }} />
        </button>
      </div>

      <div style={{ padding: "18px", display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Persona */}
        <div>
          <div style={LABEL}>Persona</div>
          <div className="seg-ctrl" style={{ display: "inline-flex", marginBottom: 10 }}>
            <button type="button" className={`seg-btn${strategy === "append" ? " active" : ""}`}
              onClick={() => switchStrategy("append")}>Append to base</button>
            <button type="button" className={`seg-btn${strategy === "replace" ? " active" : ""}`}
              onClick={() => switchStrategy("replace")}>Replace base</button>
          </div>

          {strategy === "append" && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginBottom: 4 }}>
                Base prompt (read-only) — your text below is appended after it.
              </div>
              <pre style={{
                margin: 0, maxHeight: 150, overflow: "auto", whiteSpace: "pre-wrap",
                fontSize: 12, lineHeight: 1.5, color: "var(--ink-2)", background: "var(--bg-2)",
                border: "1px solid var(--line)", borderRadius: 0, padding: "10px 12px",
              }}>{basePrompt}</pre>
            </div>
          )}

          <textarea
            className="ta"
            placeholder={strategy === "append"
              ? "Additional persona instructions to append (e.g. draft for Instagram: visual-first captions, hashtags, one CTA)…"
              : "Full system prompt that replaces the base entirely…"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={{ minHeight: 120, fontSize: 13, resize: "vertical", width: "100%" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            <span style={{ fontSize: 11.5, color: (errors.system_prompt || liveErrors.system_prompt) ? "var(--err, oklch(60% 0.2 25))" : "var(--ink-4)" }}>
              {errors.system_prompt || liveErrors.system_prompt || (strategy === "replace" ? "Replaces the base prompt entirely." : "Optional — leave blank to keep the base persona.")}
            </span>
            <span style={{ fontSize: 11.5, color: prompt.trim().length > SYSTEM_PROMPT_MAX ? "var(--err, oklch(60% 0.2 25))" : "var(--ink-4)" }}>
              {prompt.trim().length}/{SYSTEM_PROMPT_MAX}
            </span>
          </div>
        </div>

        {/* Model + max tokens */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div>
            <div style={LABEL}>Model</div>
            <select className="sel" value={model} onChange={(e) => setModel(e.target.value)}
              style={{ fontSize: 13, width: "100%" }}>
              {allowedModels.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            {(errors.model || liveErrors.model) && (
              <div style={{ fontSize: 11.5, color: "var(--err, oklch(60% 0.2 25))", marginTop: 4 }}>{errors.model || liveErrors.model}</div>
            )}
          </div>
          <div>
            <div style={LABEL}>Max tokens</div>
            <input className="input" type="number" min={MAX_TOKENS_MIN} max={MAX_TOKENS_MAX}
              value={maxTokens}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
              style={{ fontSize: 13, width: "100%" }} />
            {(errors.max_tokens || liveErrors.max_tokens) && (
              <div style={{ fontSize: 11.5, color: "var(--err, oklch(60% 0.2 25))", marginTop: 4 }}>{errors.max_tokens || liveErrors.max_tokens}</div>
            )}
          </div>
        </div>

        {/* Tools */}
        <div>
          <div style={LABEL}>Enabled tools</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {tools.map((t) => (
              <label key={t.name} style={{
                display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 10px",
                border: "1px solid var(--line)", background: "var(--bg-2)", cursor: "pointer",
              }}>
                <input type="checkbox" checked={enabled.has(t.name)} onChange={() => toggleTool(t.name)}
                  style={{ marginTop: 2 }} />
                <span style={{ minWidth: 0 }}>
                  <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{t.name}</span>
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.4 }}>{t.description}</span>
                </span>
              </label>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: (errors.enabled_tools || liveErrors.enabled_tools) ? "var(--err, oklch(60% 0.2 25))" : "var(--ink-4)", marginTop: 5 }}>
            {errors.enabled_tools || liveErrors.enabled_tools
              || (enabledTools === null ? "All tools enabled." : `${enabledTools.length} of ${tools.length} tools enabled.`)}
          </div>
        </div>

        {errors.form && (
          <div style={{ fontSize: 12.5, color: "var(--err, oklch(60% 0.2 25))" }}>{errors.form}</div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10 }}>
          {saved && (
            <>
              <span className="chip ok"><Check style={{ width: 10, height: 10 }} /> Saved</span>
              <Link href={`/agents/${slug}`} className="btn sm" scroll>
                <MessageSquare style={{ width: 12, height: 12 }} /> Test in chat
              </Link>
            </>
          )}
          <button className="btn accent sm" type="button" onClick={save} disabled={pending || hasErrors}>
            {pending ? <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} /> : <Save style={{ width: 12, height: 12 }} />}
            Save customization
          </button>
        </div>
        <p style={{ fontSize: 11.5, color: "var(--ink-4)", margin: 0 }}>
          Preview: the customization takes effect on your next chat message — scroll up and message {displayName} to try it.
          A separate sandboxed dry-run runner is a later phase.
        </p>

        {/* Version history */}
        {history.length > 0 && (
          <div>
            <div style={{ ...LABEL, display: "flex", alignItems: "center", gap: 6 }}>
              <History style={{ width: 12, height: 12 }} /> Version history
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {history.map((h, i) => (
                <div key={h.id} className="card" style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {new Date(h.created_at).toLocaleString()}
                      {i === 0 && <span className="chip ok" style={{ marginLeft: 8, fontSize: 10.5 }}>current</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {h.prompt_strategy}
                      {" · "}
                      {h.enabled_tools ? `${h.enabled_tools.length} tools` : "all tools"}
                      {h.system_prompt ? ` · "${h.system_prompt.slice(0, 60)}${h.system_prompt.length > 60 ? "…" : ""}"` : " · no persona override"}
                    </div>
                  </div>
                  {i !== 0 && (
                    <button className="btn sm" type="button" onClick={() => revert(h.id)} disabled={pending}>
                      <RotateCcw style={{ width: 11, height: 11 }} /> Revert
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
