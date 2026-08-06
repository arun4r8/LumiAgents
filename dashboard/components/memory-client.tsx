"use client";

import { useState, useTransition } from "react";
import { Brain, Trash2, Loader2, ChevronRight, ChevronDown, Sparkles, Tag } from "lucide-react";
import { AgentMark } from "@/components/agent-mark";
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
    <div className="page view-fade" style={{ maxWidth: 860 }}>
      <h1 className="p6-h1">Memory</h1>
      <div className="p6-sub" style={{ marginBottom: 20 }}>
        {conversations.length === 0
          ? "No agent conversations yet."
          : `What the agents have learned across ${conversations.length} conversation${conversations.length !== 1 ? "s" : ""} — editable, deletable`}
      </div>

      <p className="p6-sub" style={{ maxWidth: 760 }}>
        Every chat with an agent is remembered: transcripts resume across sessions, and the agent recalls
        relevant past turns, rolling summaries, and durable facts. Expand a conversation to see what&apos;s
        stored, or <strong style={{ fontWeight: 500, color: "var(--color-text)" }}>forget</strong> a single
        fact or a whole conversation (which also erases its embedded memory). Idle conversations are
        auto-purged daily by the retention job.
      </p>

      {conversations.length === 0 ? (
        <div className="empty">
          <div className="ico"><Brain /></div>
          <h4>No memory yet.</h4>
          <p>Once people chat with the agents, their conversations and learned facts show up here.</p>
        </div>
      ) : (
        <div className="p6-mem-list">
          {conversations.map((c) => (
            <ConversationCard
              key={c.id}
              conv={c}
              open={openId === c.id}
              onToggle={() => setOpenId(openId === c.id ? null : c.id)}
              loadDetail={loadDetail}
              forgetConversation={forgetConversation}
              forgetChunk={forgetChunk}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationCard({
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
    <div className={`p6-mem${open ? " is-open" : ""}`}>
      <div
        className="p6-mem-row"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
      >
        {open
          ? <ChevronDown style={{ width: 15, height: 15, color: "var(--color-neutral-500)", flexShrink: 0, marginTop: 6 }} />
          : <ChevronRight style={{ width: 15, height: 15, color: "var(--color-neutral-500)", flexShrink: 0, marginTop: 6 }} />}
        <AgentMark slug={conv.agent_slug} name={conv.agent_slug} size={28} />
        <span className="p6-mem-body">
          <span className="p6-mem-title" style={{ textTransform: "capitalize" }}>
            {conv.agent_slug}
            {conv.title
              ? <span className="dim" style={{ textTransform: "none" }}> — {conv.title}</span>
              : <span className="dim" style={{ textTransform: "none" }}> — untitled conversation</span>}
          </span>
          <span className="p6-mem-meta">
            <span><span className="mono">{conv.messageCount}</span> messages</span>
            <span><span className="mono">{conv.memoryCount}</span> {conv.memoryCount === 1 ? "memory" : "memories"}</span>
            <span className="mono">{timeAgo(conv.last_message_at)}</span>
          </span>
        </span>
        <button
          type="button"
          disabled={forgetPending}
          className="btn ghost sm"
          title="Forget this conversation (and its memory)"
          onClick={(e) => {
            e.stopPropagation();
            const fd = new FormData();
            fd.set("id", conv.id);
            startForget(async () => { await forgetConversation(fd); });
          }}
          style={{ flexShrink: 0 }}
        >
          {forgetPending
            ? <Loader2 style={{ width: 13, height: 13 }} className="spin" />
            : <><Trash2 style={{ width: 12, height: 12 }} /> Forget</>}
        </button>
      </div>

      {open && (
        <div className="p6-mem-detail">
          {loading && !detail ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-neutral-500)", fontSize: 13, gridColumn: "1 / -1" }}>
              <Loader2 style={{ width: 14, height: 14 }} className="spin" /> Loading…
            </div>
          ) : detail ? (
            <>
              <div>
                <div className="p6-mem-col-h">Transcript</div>
                <div className="p6-mem-scroll">
                  {detail.messages.length === 0 && <span style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>No messages.</span>}
                  {detail.messages.map((m) => (
                    <div key={m.id} className="p6-mem-turn">
                      <span className={`who${m.role === "user" ? " is-user" : ""}`}>{m.role}: </span>
                      <span>{m.content}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="p6-mem-col-h">Learned memory</div>
                <div className="p6-mem-scroll">
                  {detail.chunks.length === 0 && <span style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>No summaries or facts yet.</span>}
                  {detail.chunks.map((ch) => (
                    <div key={ch.id} className="p6-mem-chunk">
                      <span className={`tag ${ch.kind === "summary" ? "tag-accent" : "tag-neutral"}`} style={{ gap: 4, marginTop: 1 }}>
                        {ch.kind === "summary" ? <Sparkles style={{ width: 10, height: 10 }} /> : <Tag style={{ width: 10, height: 10 }} />}
                        {ch.kind}
                      </span>
                      <span className="txt">{ch.content}</span>
                      <button
                        type="button"
                        className="btn ghost sm"
                        title="Forget this item"
                        onClick={() => startForget(async () => {
                          const fd = new FormData();
                          fd.set("id", ch.id);
                          await forgetChunk(fd);
                          setDetail((d) => d ? { ...d, chunks: d.chunks.filter((x) => x.id !== ch.id) } : d);
                        })}
                      >
                        <Trash2 style={{ width: 12, height: 12 }} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
