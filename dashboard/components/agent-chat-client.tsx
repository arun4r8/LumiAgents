"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Send, Loader2, Paperclip, X, ArrowRight } from "lucide-react";
import mammoth from "mammoth";
import { jsPDF } from "jspdf";
import Link from "next/link";

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
    throw new Error(`"${file.name}" is a legacy .doc file — please save it as .docx or PDF first`);
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

  async function send(text?: string) {
    const msgText = (text ?? input).trim();
    if (!msgText || thinking) return;

    const userMessage: Message = {
      role: "user",
      text: msgText,
      files: pendingFiles.length > 0 ? [...pendingFiles] : undefined,
    };

    const updatedHistory = [...messages, userMessage];
    setMessages(updatedHistory);
    setInput("");
    setPendingFiles([]);
    setThinking(true);
    setError(null);

    // Build the conversation history payload (omit file blobs for prior messages)
    const conversationHistory = updatedHistory.map((m) => ({
      role: m.role,
      text: m.text,
      ...(m.files ? { files: m.files } : {}),
    }));

    try {
      const res = await fetch(`${RUNTIME_URL}/api/agents/${slug}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: conversationHistory,
          files: userMessage.files ?? [],
        }),
      });
      const data = await res.json() as ChatResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

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
                <span>Thinking…</span>
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
              title="Attach file (.txt, .csv, .pdf, .md, .json, .docx — .docx auto-converts to PDF)"
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
          border-radius: 12px;
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
          border-radius: 4px;
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
          border-radius: 5px;
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
          border-radius: 8px;
        }
        .file-chip {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 3px 6px 3px 8px;
          background: var(--bg);
          border: 1px solid var(--line-2);
          border-radius: 5px;
          font-size: 12px;
          color: var(--ink-1);
          max-width: 200px;
        }
        .file-chip-rm {
          background: none; border: none; cursor: pointer;
          color: var(--ink-3); display: flex; align-items: center;
          padding: 1px; border-radius: 3px; flex-shrink: 0;
        }
        .file-chip-rm:hover { color: var(--err); background: var(--err-soft); }

        /* input bar */
        .agent-input {
          border: 1px solid var(--line-2);
          border-radius: 12px;
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
          border-radius: 8px;
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
