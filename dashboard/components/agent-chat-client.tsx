"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Loader2, Paperclip, X } from "lucide-react";
import mammoth from "mammoth";
import { jsPDF } from "jspdf";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { runtimeAuthHeader } from "@/lib/runtime-auth";
import { AgentMark } from "@/components/agent-mark";
import { RunCard } from "@/components/run-card";

/**
 * Agent chat.
 *
 * Redesign phase 4 rewrites the PRESENTATION only — the transport, the file
 * batching, the runtime error mapping and the embedded run cards are unchanged
 * from the code that shipped with phase 3, deliberately. What changed:
 *
 *  · the header is the design's 32px mark + name + domain/live line, replacing
 *    the generic .page-h;
 *  · a user turn is a right-aligned accent-900 bubble; an AGENT turn is plain
 *    text on the page ground with no bubble at all — so the embedded run card is
 *    the only filled surface in the transcript, which is the point of the design;
 *  · the composer is one bordered pill that takes the accent border on focus,
 *    holding the input, a ghost Attach and a primary (outlined) Send;
 *  · every style moved out of this component's <style> block into app/lumi.css —
 *    one styling system. No Tailwind utility classes remain on this screen.
 *
 * Enter sends. ⌘↵ / Ctrl+↵ still sends (the behaviour people already have in
 * their fingers), and Shift+Enter inserts a newline.
 */

const RUNTIME_URL = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AttachedFile {
  name: string;
  mimeType: string;
  content: string; // text or base64
}

/** A run this turn dispatched. `orchestration` names the card before any DB read. */
interface RunRef {
  runId: string;
  orchestration?: string;
}

interface Message {
  role: "user" | "assistant";
  text: string;
  files?: AttachedFile[];
  runs?: RunRef[];
}

interface ChatResponse {
  reply: string;
  /** @deprecated The runtime still populates this; `runs` supersedes it. */
  runIds?: string[];
  runs?: RunRef[];
}

/**
 * Normalise the runtime's two run shapes into one.
 *
 * The runtime now returns `runs: [{ runId, orchestration }]` so the embedded run
 * card can name itself immediately (an enduser can always read their own run row
 * under RLS, but the joined orchestration row is only readable while that
 * orchestration is active). `runIds` is still populated as a deprecated alias —
 * the Teams path in runtime/src/routes/agents.ts reads it — and is accepted here
 * as the fallback so a mid-deploy dashboard talking to an older runtime, or vice
 * versa, still renders cards.
 */
function runsFrom(data: ChatResponse): RunRef[] {
  if (data.runs?.length) return data.runs;
  return (data.runIds ?? []).map((runId) => ({ runId }));
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface AgentChatClientProps {
  slug: string;
  agentName: string;
  /** The agent's domain — "GovCon BD", "HR & Recruiting". Shown under the name. */
  agentDomain: string;
  description: string;
  /** How many orchestrations this agent can run; the header tag. */
  orchestrationCount: number;
  suggestedPrompts: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEXT_TYPES = new Set(["text/plain", "text/csv", "text/markdown", "application/json"]);
const TEXT_EXTS  = /\.(txt|csv|md|json)$/i;

// Map a raw runtime failure to a friendly, user-safe message. The real error is
// kept in console.error for debugging; endusers never see raw runtime strings.
function friendlyRuntimeError(err: unknown): string {
  console.error("[agent-chat] runtime call failed:", err);
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b403\b|forbidden/i.test(msg)) {
    return "You don't have access to this yet — ask an ops admin.";
  }
  return "Something went wrong — try again.";
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function docxToPdf(file: File): Promise<AttachedFile> {
  const arrayBuffer = await file.arrayBuffer();
  const { value: text } = await mammoth.extractRawText({ arrayBuffer });

  const doc = new jsPDF();
  const margin = 15;
  const maxWidth = doc.internal.pageSize.getWidth() - margin * 2;
  const lineHeight = 7;
  let y = margin;

  const lines: string[] = doc.splitTextToSize(text || "(empty document)", maxWidth) as string[];
  for (const line of lines) {
    if (y > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage();
      y = margin;
    }
    doc.text(line, margin, y);
    y += lineHeight;
  }

  const pdfName = file.name.replace(/\.docx$/i, ".pdf");
  return { name: pdfName, mimeType: "application/pdf", content: arrayBufferToBase64(doc.output("arraybuffer")) };
}

async function readFile(file: File): Promise<AttachedFile> {
  if (/\.docx$/i.test(file.name)) return docxToPdf(file);
  if (/\.doc$/i.test(file.name)) {
    throw new Error(`"${file.name}" is a Word 97 file — save it as .docx or PDF and try again`);
  }
  const isText = TEXT_TYPES.has(file.type) || TEXT_EXTS.test(file.name);
  if (isText) {
    const content = await file.text();
    return { name: file.name, mimeType: file.type || "text/plain", content };
  }
  // Binary → base64
  return { name: file.name, mimeType: file.type || "application/octet-stream", content: arrayBufferToBase64(await file.arrayBuffer()) };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AgentChatClient({
  slug,
  agentName,
  agentDomain,
  description,
  orchestrationCount,
  suggestedPrompts,
}: AgentChatClientProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput]       = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);

  const bottomRef   = useRef<HTMLDivElement>(null);
  const fileRef     = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  // The composer is a one-line pill that grows with the draft, so the textarea
  // is measured rather than given a fixed `rows`. Capped by max-height in CSS.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // ── File handling ──────────────────────────────────────────────────────────

  const attachFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    try {
      const read = await Promise.all(files.map(readFile));
      setPendingFiles((prev) => {
        // Avoid duplicates by name
        const existing = new Set(prev.map((f) => f.name));
        return [...prev, ...read.filter((f) => !existing.has(f.name))];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file couldn't be read — try another format");
    }
  }, []);

  function removeFile(name: string) {
    setPendingFiles((prev) => prev.filter((f) => f.name !== name));
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) attachFiles(e.dataTransfer.files);
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  // Each batch sent to the runtime: must stay well under the 100MB Workers body limit.
  // 20 × ~300KB PDFs ≈ 6MB base64 per request, safe for any Workers plan.
  const FILE_BATCH = 20;

  // Build the payload messages array. Server-side ChatMessage uses `content` (not `text`).
  function toApiMessages(history: Message[]): Array<{ role: string; content: string }> {
    return history.map((m) => ({ role: m.role, content: m.text }));
  }

  async function callAgentChat(
    history: Message[],
    files: AttachedFile[],
  ): Promise<ChatResponse> {
    const res = await fetch(`${RUNTIME_URL}/api/agents/${slug}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await runtimeAuthHeader()) },
      body: JSON.stringify({ messages: toApiMessages(history), files }),
    });
    const data = await res.json() as ChatResponse & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  async function send(text?: string) {
    const msgText = (text ?? input).trim();
    if (!msgText || thinking) return;

    const allFiles = pendingFiles.length > 0 ? [...pendingFiles] : [];
    const userMessage: Message = { role: "user", text: msgText, files: allFiles.length > 0 ? allFiles : undefined };

    const updatedHistory = [...messages, userMessage];
    setMessages(updatedHistory);
    setInput("");
    setPendingFiles([]);
    setThinking(true);
    setError(null);

    // Large file batch: split into chunks so each request stays under Workers body limits.
    // Each chunk is sent as a continuation so Angie sees the conversation context.
    if (allFiles.length > FILE_BATCH) {
      const chunks: AttachedFile[][] = [];
      for (let i = 0; i < allFiles.length; i += FILE_BATCH) {
        chunks.push(allFiles.slice(i, i + FILE_BATCH));
      }

      let history = updatedHistory;
      let allRuns: RunRef[] = [];
      let firstReply = "";
      let missedBatches = 0;

      for (let i = 0; i < chunks.length; i++) {
        setBatchProgress({ current: i + 1, total: chunks.length });
        const isFirst = i === 0;
        // Include the original user message explicitly in batch 2+ so the LLM
        // has the full job description without relying on conversation recall.
        const batchHistory = isFirst
          ? history
          : [
              ...history,
              {
                role: "user" as const,
                text: `Batch ${i + 1}/${chunks.length}: Score these ${chunks[i]!.length} additional résumés. Use the same job description from my original request: "${msgText}". Call score_resumes with the attached files now.`,
              },
            ];

        try {
          const data = await callAgentChat(batchHistory, chunks[i]!);
          if (isFirst) firstReply = data.reply;
          const batchRuns = runsFrom(data);
          if (!isFirst && batchRuns.length === 0) {
            // LLM responded but didn't call the tool; retry once with a stronger prompt.
            const retryHistory = [
              ...batchHistory,
              { role: "assistant" as const, text: data.reply },
              {
                role: "user" as const,
                text: `You did not submit the résumés. Please call score_resumes now with jobDescription="${msgText}" and the ${chunks[i]!.length} attached files.`,
              },
            ];
            const retry = await callAgentChat(retryHistory, chunks[i]!);
            const retryRuns = runsFrom(retry);
            if (retryRuns.length === 0) missedBatches++;
            allRuns = [...allRuns, ...retryRuns];
            history = [...retryHistory, { role: "assistant" as const, text: retry.reply, runs: retryRuns }];
          } else {
            allRuns = [...allRuns, ...batchRuns];
            history = [...batchHistory, { role: "assistant" as const, text: data.reply, runs: batchRuns }];
          }
        } catch (err) {
          setError(`Batch ${i + 1}/${chunks.length} failed. ${friendlyRuntimeError(err)}`);
          setThinking(false);
          setBatchProgress(null);
          return;
        }
      }

      setBatchProgress(null);
      setThinking(false);
      const missedNote = missedBatches > 0
        ? `\n\n⚠️ ${missedBatches} batch(es) could not be submitted. Please re-upload those files.`
        : "";
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: firstReply + (chunks.length > 1 ? `\n\n*All ${allFiles.length} files submitted across ${chunks.length} batches.*` : "") + missedNote,
          runs: allRuns,
        },
      ]);
      return;
    }

    // Single-batch path (normal case).
    try {
      const data = await callAgentChat(updatedHistory, allFiles);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: data.reply, runs: runsFrom(data) },
      ]);
    } catch (err) {
      setError(friendlyRuntimeError(err));
    } finally {
      setThinking(false);
    }
  }

  /**
   * Enter sends — the handoff's composer spec. ⌘↵ / Ctrl+↵ sends too: it was the
   * ONLY way to send before this phase, so it keeps working rather than silently
   * becoming a no-op for anyone who learned it. Shift+Enter is the newline, and
   * an open IME composition is left alone.
   */
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter") return;
    if (e.shiftKey) return;
    if (e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  }

  const isEmpty = messages.length === 0;
  const canSend = (input.trim().length > 0 || pendingFiles.length > 0) && !thinking;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="chat-page">
      <header className="chat-h">
        <AgentMark slug={slug} name={agentName} size={32} />
        <span>
          <span className="chat-h-name">{agentName}</span>
          <span className="chat-h-sub">
            {agentDomain}
            {thinking && (
              <>
                {" · "}
                <span className="live">working…</span>
              </>
            )}
          </span>
        </span>
        <div className="chat-h-actions">
          {!isEmpty && (
            <button
              type="button"
              className="btn sm"
              onClick={() => { setMessages([]); setError(null); }}
            >
              New chat
            </button>
          )}
          <span className="tag tag-outline">
            {orchestrationCount === 1 ? "1 orchestration" : `${orchestrationCount} orchestrations`}
          </span>
        </div>
      </header>

      <div className="chat-log">
        {isEmpty ? (
          <div className="chat-empty">
            <AgentMark slug={slug} name={agentName} size={44} />
            <div className="chat-empty-name">{agentName}</div>
            <p className="chat-empty-desc">{description}</p>
            <p className="chat-empty-hint">
              Say what you need in plain language. {agentName} works out which of its
              orchestrations to run, and anything it starts appears right here as a run
              you can watch.
            </p>
            {suggestedPrompts.length > 0 && (
              <div className="chat-chips">
                {suggestedPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="ex-chip"
                    onClick={() => send(prompt)}
                    disabled={thinking}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          messages.map((msg, i) => <MessageTurn key={i} message={msg} />)
        )}

        {thinking && (
          <div className="chat-thinking">
            <Loader2 className="spin" style={{ width: 14, height: 14, flexShrink: 0 }} />
            <span>
              {batchProgress
                ? `Working through batch ${batchProgress.current} of ${batchProgress.total}…`
                : "Thinking…"}
            </span>
          </div>
        )}

        {error && <div className="chat-error" role="alert">{error}</div>}

        <div ref={bottomRef} />
      </div>

      <div
        className="chat-composer"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        {pendingFiles.length > 0 && (
          <div className="chat-files">
            {pendingFiles.map((f) => (
              <span key={f.name} className="chat-file">
                <Paperclip style={{ width: 11, height: 11, flexShrink: 0 }} />
                <span className="truncate">{f.name}</span>
                <button
                  type="button"
                  className="chat-file-rm"
                  onClick={() => removeFile(f.name)}
                  aria-label={`Remove ${f.name}`}
                  title={`Remove ${f.name}`}
                >
                  <X style={{ width: 10, height: 10 }} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className={dragging ? "chat-pill is-drag" : "chat-pill"}>
          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder={
              dragging
                ? "Drop the files here"
                : `Message ${agentName} — attach files, trigger orchestrations…`
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={thinking}
            rows={1}
          />

          <label
            className="btn ghost sm"
            style={{ cursor: "pointer" }}
            title="Attach a file — .txt, .csv, .md, .json, .pdf or .docx. Word files are converted to PDF for you, and you can drop files straight onto the box."
          >
            <Paperclip style={{ width: 12, height: 12 }} />
            Attach
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.csv,.pdf,.md,.json,.docx,.doc"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) attachFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>

          <button
            type="button"
            className="btn primary sm"
            onClick={() => send()}
            disabled={!canSend}
          >
            {thinking ? "Working" : "Send"}
          </button>
        </div>

        <div className="chat-hint">
          <span>Enter sends · Shift + Enter starts a new line</span>
          <span>Drop files straight onto the box to attach them</span>
        </div>
      </div>
    </div>
  );
}

// ─── One turn ─────────────────────────────────────────────────────────────────

function MessageTurn({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const runs = isUser ? [] : message.runs ?? [];

  return (
    <div className={`chat-msg ${isUser ? "is-user" : "is-agent"}`}>
      {isUser ? (
        <div className="chat-bubble">
          {message.text}
          {message.files && message.files.length > 0 && (
            <div className="chat-bubble-files">
              {message.files.map((f) => (
                <span key={f.name} className="chat-bubble-file">
                  <Paperclip style={{ width: 10, height: 10, flexShrink: 0 }} />
                  <span className="truncate">{f.name}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="chat-text chat-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
        </div>
      )}

      {/*
        The runs this turn started, as live run cards — the redesign's signature
        component, in place of the old static "View run →" chip. Each card follows
        its own run to completion through the RLS-scoped /api/runs/:id poll, so an
        enduser watching a run their chat triggered sees exactly the same thing ops
        does. Unchanged by phase 4 except that the agent turn around them is now
        plain text, so the card is the only filled surface in the transcript —
        which is what the design is after.
      */}
      {runs.length > 0 && (
        <div className="chat-runs">
          {runs.map((r) => (
            <RunCard key={r.runId} runId={r.runId} orchestration={r.orchestration} />
          ))}
        </div>
      )}
    </div>
  );
}
