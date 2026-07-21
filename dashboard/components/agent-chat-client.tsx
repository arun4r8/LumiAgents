"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Send, Loader2, Paperclip, X, ArrowRight } from "lucide-react";
import mammoth from "mammoth";
import { jsPDF } from "jspdf";
import Link from "next/link";
import { runtimeAuthHeader } from "@/lib/runtime-auth";

const RUNTIME_URL = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AttachedFile {
  name: string;
  mimeType: string;
  content: string; // text or base64
}

interface Message {
  role: "user" | "assistant";
  text: string;
  files?: AttachedFile[];
  runIds?: string[];
}

interface ChatResponse {
  reply: string;
  runIds?: string[];
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface AgentChatClientProps {
  slug: string;
  agentName: string;
  agentEmoji: string;
  description: string;
  suggestedPrompts: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEXT_TYPES = new Set(["text/plain", "text/csv", "text/markdown", "application/json"]);
const TEXT_EXTS  = /\.(txt|csv|md|json)$/i;

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
    throw new Error(`"${file.name}" is a legacy .doc file. Please save it as .docx or PDF first`);
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
  agentEmoji,
  description,
  suggestedPrompts,
}: AgentChatClientProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput]       = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);

  const bottomRef  = useRef<HTMLDivElement>(null);
  const fileRef    = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

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
      setError(err instanceof Error ? err.message : "Failed to read file");
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
      let allRunIds: string[] = [];
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
          const batchRunIds = data.runIds ?? [];
          if (!isFirst && batchRunIds.length === 0) {
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
            const retryRunIds = retry.runIds ?? [];
            if (retryRunIds.length === 0) missedBatches++;
            allRunIds = [...allRunIds, ...retryRunIds];
            history = [...retryHistory, { role: "assistant" as const, text: retry.reply, runIds: retryRunIds }];
          } else {
            allRunIds = [...allRunIds, ...batchRunIds];
            history = [...batchHistory, { role: "assistant" as const, text: data.reply, runIds: batchRunIds }];
          }
        } catch (err) {
          setError(`Batch ${i + 1}/${chunks.length} failed: ${err instanceof Error ? err.message : "network error"}`);
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
          runIds: allRunIds,
        },
      ]);
      return;
    }

    // Single-batch path (normal case).
    try {
      const data = await callAgentChat(updatedHistory, allFiles);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: data.reply, runIds: data.runIds ?? [] },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setThinking(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  }

  const isEmpty = messages.length === 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="page view-fade agent-chat-page">
      {/* Page header */}
      <div className="page-h">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 28, lineHeight: 1 }} aria-hidden="true">{agentEmoji}</span>
          <div>
            <h1 style={{ margin: 0 }}>{agentName}</h1>
            <div className="sub">{description}</div>
          </div>
        </div>
        {!isEmpty && (
          <button className="btn sm" onClick={() => { setMessages([]); setError(null); }}>
            New chat
          </button>
        )}
      </div>

      {/* Chat shell */}
      <div className="agent-shell">

        {/* ── Messages ── */}
        <div className="agent-messages">
          {isEmpty ? (
            <div className="agent-empty">
              <div className="agent-empty-emoji" aria-hidden="true">{agentEmoji}</div>
              <div className="agent-empty-name">{agentName}</div>
              <div className="agent-empty-desc">{description}</div>
              <div className="ex-chips" style={{ justifyContent: "center", marginTop: 16 }}>
                {suggestedPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    className="ex-chip"
                    onClick={() => send(prompt)}
                    disabled={thinking}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))
          )}

          {/* Thinking bubble */}
          {thinking && (
            <div className="msg-row assistant">
              <div className="msg-bubble thinking">
                <Loader2 style={{ width: 14, height: 14, animation: "spin 1s linear infinite", flexShrink: 0 }} />
                <span>
                  {batchProgress
                    ? `Processing batch ${batchProgress.current} of ${batchProgress.total}…`
                    : "Thinking…"}
                </span>
              </div>
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div className="agent-error">{error}</div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* ── File chip preview ── */}
        {pendingFiles.length > 0 && (
          <div className="agent-file-chips">
            {pendingFiles.map((f) => (
              <div key={f.name} className="file-chip">
                <Paperclip style={{ width: 11, height: 11, flexShrink: 0 }} />
                <span className="truncate">{f.name}</span>
                <button
                  className="file-chip-rm"
                  onClick={() => removeFile(f.name)}
                  title="Remove"
                >
                  <X style={{ width: 10, height: 10 }} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ── Input bar ── */}
        <div
          className={`agent-input${dragging ? " drag-over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <textarea
            ref={textareaRef}
            className="agent-textarea"
            placeholder={`Message ${agentName}… (⌘↵ to send)`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={thinking}
            rows={3}
          />
          <div className="agent-input-foot">
            {/* File upload */}
            <label
              className="btn sm"
              title="Attach file (.txt, .csv, .pdf, .md, .json, .docx; .docx auto-converts to PDF)"
              style={{ cursor: "pointer" }}
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

            <div className="row gap-sm" style={{ alignItems: "center" }}>
              <span className="muted mono" style={{ fontSize: 11.5 }}>
                {thinking ? "Working…" : "⌘ + ↵ to send"}
              </span>
              <button
                className="btn accent"
                onClick={() => send()}
                disabled={(!input.trim() && pendingFiles.length === 0) || thinking}
              >
                {thinking
                  ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Working</>
                  : <><Send style={{ width: 13, height: 13 }} /> Send</>}
              </button>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }

        .agent-chat-page { display: flex; flex-direction: column; }

        .agent-shell {
          display: flex; flex-direction: column;
          max-width: 860px;
          gap: 10px;
        }

        /* messages area */
        .agent-messages {
          display: flex; flex-direction: column; gap: 12px;
          min-height: 200px;
          max-height: calc(100vh - 340px);
          overflow-y: auto;
          padding: 4px 2px 8px;
        }

        /* empty state */
        .agent-empty {
          display: flex; flex-direction: column; align-items: center;
          padding: 48px 20px; text-align: center; color: var(--ink-2);
        }
        .agent-empty-emoji { font-size: 44px; line-height: 1; margin-bottom: 12px; }
        .agent-empty-name { font-size: 17px; font-weight: 600; color: var(--ink); margin-bottom: 6px; }
        .agent-empty-desc { font-size: 13.5px; color: var(--ink-2); max-width: 480px; line-height: 1.55; }

        /* message rows */
        .msg-row { display: flex; }
        .msg-row.user      { justify-content: flex-end; }
        .msg-row.assistant { justify-content: flex-start; }

        .msg-bubble {
          max-width: 78%;
          padding: 10px 14px;
          border-radius: 0;
          font-size: 13.5px;
          line-height: 1.6;
          white-space: pre-wrap;
          overflow-wrap: break-word;
        }
        .msg-row.user .msg-bubble {
          background: var(--accent);
          color: #fff;
          border-bottom-right-radius: 4px;
        }
        .msg-row.assistant .msg-bubble {
          background: var(--bg-2);
          color: var(--ink-1);
          border-bottom-left-radius: 4px;
          border: 1px solid var(--line);
        }

        /* thinking */
        .msg-bubble.thinking {
          display: flex; align-items: center; gap: 8px;
          color: var(--ink-3); font-style: italic;
          animation: thinking-pulse 1.4s ease-in-out infinite;
        }
        @keyframes thinking-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: .55; }
        }

        /* attached file chips on user message */
        .msg-files {
          display: flex; flex-wrap: wrap; gap: 5px;
          margin-top: 6px;
        }
        .msg-file-chip {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 2px 7px;
          background: rgba(255,255,255,.18);
          border: 1px solid rgba(255,255,255,.25);
          border-radius: 0;
          font-size: 11px;
          max-width: 180px;
        }

        /* run link chip on assistant message */
        .msg-runs {
          display: flex; flex-wrap: wrap; gap: 6px;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid var(--line);
        }
        .run-chip {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 3px 8px;
          background: var(--accent-soft);
          color: var(--accent-ink);
          border: 1px solid var(--accent-line);
          border-radius: 0;
          font-size: 11.5px;
          font-weight: 500;
          text-decoration: none;
          transition: background .1s;
        }
        .run-chip:hover { background: var(--accent-line); }

        /* pending file chips above input */
        .agent-file-chips {
          display: flex; flex-wrap: wrap; gap: 7px;
          padding: 8px 12px;
          background: var(--bg-1);
          border: 1px solid var(--line);
          border-radius: 0;
        }
        .file-chip {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 3px 6px 3px 8px;
          background: var(--bg);
          border: 1px solid var(--line-2);
          border-radius: 0;
          font-size: 12px;
          color: var(--ink-1);
          max-width: 200px;
        }
        .file-chip-rm {
          background: none; border: none; cursor: pointer;
          color: var(--ink-3); display: flex; align-items: center;
          padding: 1px; border-radius: 0; flex-shrink: 0;
        }
        .file-chip-rm:hover { color: var(--err); background: var(--err-soft); }

        /* input bar */
        .agent-input {
          border: 1px solid var(--line-2);
          border-radius: 0;
          background: var(--bg);
          padding: 12px 14px;
          box-shadow: var(--shadow-md);
          transition: border-color .12s, box-shadow .12s;
        }
        .agent-input:focus-within {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-md);
        }
        .agent-input.drag-over {
          border-color: var(--accent);
          background: var(--accent-soft);
        }
        .agent-textarea {
          width: 100%; border: 0; outline: 0; resize: none;
          font-family: var(--sans); font-size: 14px; line-height: 1.55;
          background: transparent; color: var(--ink);
        }
        .agent-input-foot {
          display: flex; align-items: center; justify-content: space-between;
          margin-top: 8px;
        }

        /* error */
        .agent-error {
          padding: 10px 14px;
          border: 1px solid var(--err-line);
          border-radius: 0;
          background: var(--err-soft);
          color: var(--err);
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  return (
    <div className={`msg-row ${message.role}`}>
      <div className="msg-bubble">
        <div>{message.text}</div>

        {/* File chips on user messages */}
        {message.role === "user" && message.files && message.files.length > 0 && (
          <div className="msg-files">
            {message.files.map((f) => (
              <div key={f.name} className="msg-file-chip">
                <Paperclip style={{ width: 10, height: 10, flexShrink: 0 }} />
                <span className="truncate">{f.name}</span>
              </div>
            ))}
          </div>
        )}

        {/* Run links on assistant messages */}
        {message.role === "assistant" && message.runIds && message.runIds.length > 0 && (
          <div className="msg-runs">
            {message.runIds.map((id) => (
              <Link key={id} href={`/runs/${id}`} className="run-chip">
                View run <ArrowRight style={{ width: 11, height: 11 }} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
