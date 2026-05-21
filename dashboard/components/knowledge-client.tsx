"use client";

import { useState, useTransition } from "react";
import { RefreshCw, Loader2, Check, AlertTriangle, FileText, Clock, BookOpen } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "";

interface VaultRun {
  id: string;
  status: string;
  input: { changedPaths?: string[]; removedPaths?: string[]; repoName?: string } | null;
  output: { ingested?: number; skipped?: number; errors?: string[] } | null;
  started_at: string;
  completed_at: string | null;
  triggered_by: string;
}

interface VaultDoc {
  id: string;
  source_name: string;
  source_uri: string | null;
  created_at: string;
}

interface Props {
  recentRuns: VaultRun[];
  vaultDocs: VaultDoc[];
  triggerManualSync: (repoOwner: string, repoName: string) => Promise<{ runId: string }>;
}

export function KnowledgeClient({ recentRuns: initialRuns, vaultDocs }: Props) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ runId: string } | "error" | null>(null);
  const [, startTransition] = useTransition();

  const lastRun = initialRuns[0] ?? null;
  const lastSyncedAt = lastRun?.completed_at ?? lastRun?.started_at ?? null;

  async function handleManualSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${RUNTIME}/api/vault/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ repoOwner: "arun4r8", repoName: "LumiKnowledge" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { runId: string };
      setSyncResult(data);
    } catch {
      setSyncResult("error");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Knowledge Base</h1>
          <div className="sub">Obsidian vault · synced to RAG on every push to LumiKnowledge</div>
        </div>
        <button
          className="btn accent"
          onClick={handleManualSync}
          disabled={syncing}
        >
          {syncing
            ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Syncing…</>
            : <><RefreshCw style={{ width: 13, height: 13 }} /> Sync now</>
          }
        </button>
      </div>

      {syncResult && syncResult !== "error" && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 14px", borderRadius: 8, marginBottom: 20,
          background: "var(--ok-soft, oklch(97% 0.02 145))",
          border: "1px solid oklch(88% 0.06 145)",
          fontSize: 13, color: "var(--ok)",
        }}>
          <Check style={{ width: 13, height: 13 }} />
          Full sync started — <a href={`/runs/${syncResult.runId}`} style={{ color: "var(--accent)", textDecoration: "underline" }}>view run</a>
        </div>
      )}
      {syncResult === "error" && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 14px", borderRadius: 8, marginBottom: 20,
          background: "var(--err-soft)", border: "1px solid var(--err-line)",
          fontSize: 13, color: "var(--err)",
        }}>
          <AlertTriangle style={{ width: 13, height: 13 }} /> Sync failed — check runtime logs
        </div>
      )}

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
        <StatCard
          icon={<BookOpen style={{ width: 15, height: 15 }} />}
          label="Notes indexed"
          value={String(vaultDocs.length)}
        />
        <StatCard
          icon={<Clock style={{ width: 15, height: 15 }} />}
          label="Last sync"
          value={lastSyncedAt ? relativeTime(lastSyncedAt) : "Never"}
        />
        <StatCard
          icon={<Check style={{ width: 15, height: 15 }} />}
          label="Last status"
          value={lastRun ? capitalize(lastRun.status) : "—"}
          accent={lastRun?.status === "completed" ? "ok" : lastRun?.status === "failed" ? "err" : undefined}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>
        {/* Recent syncs */}
        <section>
          <h3 style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 8 }}>
            Recent syncs
          </h3>
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            {initialRuns.length === 0 ? (
              <div style={{ padding: "20px 16px", fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                No syncs yet — push a note to LumiKnowledge to trigger the first one.
              </div>
            ) : (
              initialRuns.map((run, i) => {
                const changed = run.input?.changedPaths?.length ?? 0;
                const removed = run.input?.removedPaths?.length ?? 0;
                const ingested = run.output?.ingested;
                return (
                  <div key={run.id} style={{
                    padding: "10px 14px",
                    borderBottom: i < initialRuns.length - 1 ? "1px solid var(--line)" : "none",
                    display: "flex", alignItems: "flex-start", gap: 10,
                  }}>
                    <div style={{
                      width: 7, height: 7, borderRadius: "50%", marginTop: 5, flexShrink: 0,
                      background: run.status === "completed" ? "var(--ok)" : run.status === "failed" ? "var(--err)" : "var(--ink-3)",
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 500 }}>
                        {run.triggered_by === "webhook" ? "Push sync" : "Manual sync"}
                        {ingested != null && <span style={{ color: "var(--ink-3)", fontWeight: 400 }}> · {ingested} ingested</span>}
                        {changed > 0 && ingested == null && <span style={{ color: "var(--ink-3)", fontWeight: 400 }}> · {changed} changed</span>}
                        {removed > 0 && <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>, {removed} removed</span>}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>
                        {relativeTime(run.started_at)}
                        {run.status === "running" && " · running"}
                      </div>
                    </div>
                    <a href={`/runs/${run.id}`} style={{ fontSize: 11.5, color: "var(--ink-3)", flexShrink: 0 }}>→</a>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Indexed notes */}
        <section>
          <h3 style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 8 }}>
            Indexed notes
          </h3>
          <div className="card" style={{ padding: 0, overflow: "hidden", maxHeight: 400, overflowY: "auto" }}>
            {vaultDocs.length === 0 ? (
              <div style={{ padding: "20px 16px", fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                No vault notes indexed yet.
              </div>
            ) : (
              vaultDocs.map((doc, i) => (
                <div key={doc.id} style={{
                  padding: "9px 14px",
                  borderBottom: i < vaultDocs.length - 1 ? "1px solid var(--line)" : "none",
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  <FileText style={{ width: 12, height: 12, color: "var(--ink-3)", flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {doc.source_name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-4)" }}>{relativeTime(doc.created_at)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function StatCard({ icon, label, value, accent }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: "ok" | "err";
}) {
  return (
    <div className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-3)" }}>
        {icon}
        <span style={{ fontSize: 11.5, fontWeight: 500 }}>{label}</span>
      </div>
      <div style={{
        fontSize: 22, fontWeight: 700,
        color: accent === "ok" ? "var(--ok)" : accent === "err" ? "var(--err)" : "var(--ink)",
      }}>
        {value}
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
