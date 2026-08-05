"use client";

import { useState, useTransition } from "react";
import { Brain, Trash2, Loader2, ChevronRight, ChevronDown, Sparkles, Tag } from "lucide-react";
import type { ConversationSummary, MemoryMessage, MemoryChunk } from "@/app/(dashboard)/memory/page";

interface Props {
  conversations: ConversationSummary[];
  loadDetail: (conversationId: string) => Promise<{ messages: MemoryMessage[]; chunks: MemoryChunk[] }>;
  forgetConversation: (formData: FormData) => Promise<void>;
  forgetChunk: (formData: FormData) => Promise<void>;
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function MemoryClient({ conversations, loadDetail, forgetConversation, forgetChunk }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Memory</h1>
          <div className="sub">
            {conversations.length === 0
              ? "No agent conversations yet."
              : `${conversations.length} conversation${conversations.length !== 1 ? "s" : ""} across the agents`}
          </div>
        </div>
      </div>

      <p className="sub" style={{ marginBottom: 16, maxWidth: 760 }}>
        Every chat with an agent is remembered: transcripts resume across sessions, and the agent recalls
        relevant past turns, rolling summaries, and durable facts. Expand a conversation to see what&apos;s
        stored, or <strong>forget</strong> a single fact or a whole conversation (which also erases its
        embedded memory). Idle conversations are auto-purged daily by the retention job.
      </p>

      {conversations.length === 0 ? (
        <div className="empty">
          <div className="ico"><Brain /></div>
          <h4>No memory yet.</h4>
          <p>Once people chat with the agents, their conversations and learned facts show up here.</p>
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)" }}>
                {["", "Agent", "Conversation", "Msgs", "Memory", "Last active", ""].map((h, i) => (
                  <th key={i} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-3)", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <ConversationRow
                  key={c.id}
                  conv={c}
                  open={openId === c.id}
                  onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                  loadDetail={loadDetail}
                  forgetConversation={forgetConversation}
                  forgetChunk={forgetChunk}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConversationRow({
  conv, open, onToggle, loadDetail, forgetConversation, forgetChunk,
}: {
  conv: ConversationSummary;
  open: boolean;
  onToggle: () => void;
  loadDetail: Props["loadDetail"];
  forgetConversation: Props["forgetConversation"];
  forgetChunk: Props["forgetChunk"];
}) {
  const [detail, setDetail] = useState<{ messages: MemoryMessage[]; chunks: MemoryChunk[] } | null>(null);
  const [loading, startLoad] = useTransition();
  const [forgetPending, startForget] = useTransition();

  function toggle() {
    if (!open && !detail) {
      startLoad(async () => {
        const d = await loadDetail(conv.id);
        setDetail(d);
      });
    }
    onToggle();
  }

  return (
    <>
      <tr style={{ borderBottom: "1px solid var(--line)", cursor: "pointer" }} onClick={toggle}>
        <td style={{ padding: "12px 16px", width: 28 }}>
          {open ? <ChevronDown style={{ width: 15, height: 15, color: "var(--ink-3)" }} /> : <ChevronRight style={{ width: 15, height: 15, color: "var(--ink-3)" }} />}
        </td>
        <td style={{ padding: "12px 16px" }}>
          <span className="chip" style={{ fontSize: 12, textTransform: "capitalize" }}>{conv.agent_slug}</span>
        </td>
        <td style={{ padding: "12px 16px" }}>
          <span style={{ fontSize: 13.5, color: "var(--ink)" }}>
            {conv.title ?? <span style={{ color: "var(--ink-3)" }}>Untitled conversation</span>}
          </span>
        </td>
        <td style={{ padding: "12px 16px" }}>
          <span className="mono" style={{ fontSize: 12.5, color: "var(--ink-1)" }}>{conv.messageCount}</span>
        </td>
        <td style={{ padding: "12px 16px" }}>
          <span className="mono" style={{ fontSize: 12.5, color: conv.memoryCount > 0 ? "var(--ink-1)" : "var(--ink-3)" }}>{conv.memoryCount}</span>
        </td>
        <td style={{ padding: "12px 16px" }}>
          <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{timeAgo(conv.last_message_at)}</span>
        </td>
        <td style={{ padding: "12px 16px", textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
          <form action={(fd) => startForget(async () => { await forgetConversation(fd); })} style={{ display: "inline" }}>
            <input type="hidden" name="id" value={conv.id} />
            <button type="submit" className="btn ghost sm" disabled={forgetPending} title="Forget this conversation (and its memory)">
              {forgetPending ? <Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> : <Trash2 style={{ width: 13, height: 13 }} />}
            </button>
          </form>
        </td>
      </tr>
      {open && (
        <tr style={{ background: "var(--bg-2)" }}>
          <td colSpan={7} style={{ padding: "12px 20px 20px 44px" }}>
            {loading && !detail ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-3)", fontSize: 13, padding: "8px 0" }}>
                <Loader2 style={{ width: 14, height: 14, animation: "spin 1s linear infinite" }} /> Loading…
              </div>
            ) : detail ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ink-3)", marginBottom: 8 }}>Transcript</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 320, overflowY: "auto" }}>
                    {detail.messages.length === 0 && <span style={{ color: "var(--ink-3)", fontSize: 13 }}>No messages.</span>}
                    {detail.messages.map((m) => (
                      <div key={m.id} style={{ fontSize: 13, lineHeight: 1.45 }}>
                        <span style={{ fontWeight: 600, color: m.role === "user" ? "var(--accent)" : "var(--ink-1)", textTransform: "capitalize" }}>{m.role}: </span>
                        <span style={{ color: "var(--ink-2)" }}>{m.content}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ink-3)", marginBottom: 8 }}>Learned memory</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 320, overflowY: "auto" }}>
                    {detail.chunks.length === 0 && <span style={{ color: "var(--ink-3)", fontSize: 13 }}>No summaries or facts yet.</span>}
                    {detail.chunks.map((ch) => (
                      <div key={ch.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, lineHeight: 1.45 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: ch.kind === "summary" ? "var(--info-soft)" : "var(--warn-soft)", color: ch.kind === "summary" ? "var(--info)" : "var(--warn)", borderRadius: 0, padding: "1px 6px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", whiteSpace: "nowrap", marginTop: 1 }}>
                          {ch.kind === "summary" ? <Sparkles style={{ width: 10, height: 10 }} /> : <Tag style={{ width: 10, height: 10 }} />}
                          {ch.kind}
                        </span>
                        <span style={{ color: "var(--ink-2)", flex: 1 }}>{ch.content}</span>
                        <form action={(fd) => startForget(async () => { await forgetChunk(fd); setDetail((d) => d ? { ...d, chunks: d.chunks.filter((x) => x.id !== ch.id) } : d); })} style={{ display: "inline" }}>
                          <input type="hidden" name="id" value={ch.id} />
                          <button type="submit" className="btn ghost sm" title="Forget this item">
                            <Trash2 style={{ width: 12, height: 12 }} />
                          </button>
                        </form>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </td>
        </tr>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}
