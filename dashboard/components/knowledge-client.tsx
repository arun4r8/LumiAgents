"use client";

import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw, Loader2, Check, AlertTriangle, FileText,
  Clock, BookOpen, Plus, Trash2, Save, ChevronRight, ChevronDown,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { DocumentCorpus, type OrcDocument, type CorpusDoc } from "@/components/document-corpus";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────

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

interface VaultFile {
  path: string;
  sha: string;
}

type KnowledgeTab = "editor" | "sync" | "corpus";

const TAB_LABELS: Record<KnowledgeTab, string> = {
  editor: "Editor",
  sync: "Sync",
  corpus: "Document Corpus",
};

interface Props {
  recentRuns: VaultRun[];
  vaultDocs: VaultDoc[];
  documents: OrcDocument[];
  corpusDocs: CorpusDoc[];
  deleteDocument: (id: string) => Promise<void>;
  initialTab?: KnowledgeTab;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function KnowledgeClient({
  recentRuns: initialRuns,
  vaultDocs,
  documents,
  corpusDocs,
  deleteDocument,
  initialTab = "editor",
}: Props) {
  const [tab, setTab] = useState<KnowledgeTab>(initialTab);

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Knowledge Base</h1>
          <div className="sub">Obsidian vault editor and shared RAG document corpus</div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 2, marginBottom: 20, borderBottom: "1px solid var(--line)", paddingBottom: 0 }}>
        {(["editor", "sync", "corpus"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "7px 14px",
              fontSize: 13,
              fontWeight: 500,
              background: "none",
              border: "none",
              borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
              color: tab === t ? "var(--accent)" : "var(--ink-3)",
              cursor: "pointer",
              marginBottom: -1,
              transition: "color .15s, border-color .15s",
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === "editor" && <EditorTab />}
      {tab === "sync" && <SyncTab initialRuns={initialRuns} vaultDocs={vaultDocs} />}
      {tab === "corpus" && (
        <DocumentCorpus
          documents={documents}
          corpusDocs={corpusDocs}
          deleteDocument={deleteDocument}
        />
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Editor tab ───────────────────────────────────────────────────────────────

type TreeNode =
  | { kind: "file"; path: string; sha: string; name: string }
  | { kind: "dir"; name: string; children: TreeNode[] };

function buildTree(files: VaultFile[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split("/");
    let nodes = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i]!;
      let dir = nodes.find((n): n is TreeNode & { kind: "dir" } => n.kind === "dir" && n.name === dirName);
      if (!dir) {
        dir = { kind: "dir", name: dirName, children: [] };
        nodes.push(dir);
      }
      nodes = dir.children;
    }

    nodes.push({ kind: "file", path: file.path, sha: file.sha, name: parts[parts.length - 1]! });
  }

  return root;
}

function EditorTab() {
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [loadingTree, setLoadingTree] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveMsg, setSaveMsg] = useState<"saved" | "error" | null>(null);

  const [newPath, setNewPath] = useState("");
  const [showNewInput, setShowNewInput] = useState(false);

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const getToken = useCallback(async () => {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) return session.access_token;
    // getSession() can return null if the SSR cookie hasn't been read yet;
    // getUser() makes a network call that refreshes and returns a valid session.
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data: { session: fresh } } = await supabase.auth.getSession();
    return fresh?.access_token ?? null;
  }, []);

  const authHeaders = useCallback(async () => {
    const token = await getToken();
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }, [getToken]);

  const loadTree = useCallback(async () => {
    setLoadingTree(true);
    setTreeError(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${RUNTIME}/api/vault/files/tree`, { headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { files: VaultFile[] };
      setFiles(data.files);
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : "Failed to load files");
    } finally {
      setLoadingTree(false);
    }
  }, [authHeaders]);

  useEffect(() => { void loadTree(); }, [loadTree]);

  async function selectFile(path: string, sha: string) {
    if (selectedPath === path) return;
    setLoadingFile(true);
    setSaveMsg(null);
    setSelectedPath(path);
    setSelectedSha(sha);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${RUNTIME}/api/vault/files?path=${encodeURIComponent(path)}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { content: string; sha: string };
      setContent(data.content);
      setSelectedSha(data.sha);
    } catch {
      setContent("");
    } finally {
      setLoadingFile(false);
    }
  }

  async function handleSave() {
    if (!selectedPath) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${RUNTIME}/api/vault/files`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ path: selectedPath, content, sha: selectedSha ?? undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sha: string };
      setSelectedSha(data.sha);
      setFiles((prev) => prev.map((f) => f.path === selectedPath ? { ...f, sha: data.sha } : f));
      setSaveMsg("saved");
    } catch {
      setSaveMsg("error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedPath || !selectedSha) return;
    if (!window.confirm(`Delete ${selectedPath}?`)) return;
    setDeleting(true);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${RUNTIME}/api/vault/files`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ path: selectedPath, sha: selectedSha }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFiles((prev) => prev.filter((f) => f.path !== selectedPath));
      setSelectedPath(null);
      setSelectedSha(null);
      setContent("");
    } catch {
      alert("Delete failed. Check runtime logs.");
    } finally {
      setDeleting(false);
    }
  }

  async function handleNewFile(e: React.FormEvent) {
    e.preventDefault();
    const path = newPath.trim().replace(/^\/+/, "");
    if (!path) return;
    const finalPath = path.endsWith(".md") ? path : `${path}.md`;
    setSaving(true);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${RUNTIME}/api/vault/files`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ path: finalPath, content: `# ${finalPath.split("/").pop()?.replace(".md", "")}\n\n` }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { path: string; sha: string };
      const newFile: VaultFile = { path: data.path, sha: data.sha };
      setFiles((prev) => [...prev, newFile]);
      setShowNewInput(false);
      setNewPath("");
      await selectFile(data.path, data.sha);
      // Expand parent dir if any
      const parts = data.path.split("/");
      if (parts.length > 1) {
        const dirPath = parts.slice(0, -1).join("/");
        setExpandedDirs((prev) => new Set([...prev, dirPath]));
      }
    } catch {
      alert("Failed to create file");
    } finally {
      setSaving(false);
    }
  }

  const tree = buildTree(files);

  function toggleDir(name: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function renderTree(nodes: TreeNode[], prefix = ""): React.ReactNode {
    return nodes.map((node) => {
      if (node.kind === "dir") {
        const key = prefix ? `${prefix}/${node.name}` : node.name;
        const expanded = expandedDirs.has(key);
        return (
          <div key={key}>
            <button
              onClick={() => toggleDir(key)}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "4px 8px", width: "100%", textAlign: "left",
                background: "none", border: "none", cursor: "pointer",
                fontSize: 12, color: "var(--ink-2)", fontWeight: 600,
              }}
            >
              {expanded
                ? <ChevronDown style={{ width: 12, height: 12, flexShrink: 0 }} />
                : <ChevronRight style={{ width: 12, height: 12, flexShrink: 0 }} />
              }
              {node.name}
            </button>
            {expanded && (
              <div style={{ paddingLeft: 14 }}>
                {renderTree(node.children, key)}
              </div>
            )}
          </div>
        );
      }
      const isSelected = node.path === selectedPath;
      return (
        <button
          key={node.path}
          onClick={() => void selectFile(node.path, node.sha)}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "4px 8px", width: "100%", textAlign: "left",
            background: isSelected ? "var(--accent-soft, oklch(95% 0.04 260))" : "none",
            border: "none", cursor: "pointer", borderRadius: 0,
            fontSize: 12.5, color: isSelected ? "var(--accent)" : "var(--ink)",
          }}
        >
          <FileText style={{ width: 11, height: 11, flexShrink: 0, color: "var(--ink-3)" }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
        </button>
      );
    });
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 16, alignItems: "start" }}>
      {/* File tree */}
      <div className="card" style={{ padding: "10px 0", minHeight: 400 }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 10px 8px", borderBottom: "1px solid var(--line)", marginBottom: 4,
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-3)" }}>
            Files
          </span>
          <button
            title="New file"
            onClick={() => setShowNewInput(true)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-3)", padding: 2 }}
          >
            <Plus style={{ width: 13, height: 13 }} />
          </button>
        </div>

        {showNewInput && (
          <form onSubmit={(e) => void handleNewFile(e)} style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)", marginBottom: 4 }}>
            <input
              autoFocus
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="path/to/note.md"
              style={{
                width: "100%", fontSize: 12, padding: "4px 6px",
                border: "1px solid var(--line)", borderRadius: 0,
                background: "var(--surface)", color: "var(--ink)",
                boxSizing: "border-box",
              }}
              onKeyDown={(e) => { if (e.key === "Escape") { setShowNewInput(false); setNewPath(""); } }}
            />
          </form>
        )}

        {loadingTree ? (
          <div style={{ padding: "20px 10px", fontSize: 12, color: "var(--ink-3)", textAlign: "center" }}>
            <Loader2 style={{ width: 14, height: 14, animation: "spin 1s linear infinite" }} />
          </div>
        ) : treeError ? (
          <div style={{ padding: "10px", fontSize: 12, color: "var(--err)" }}>{treeError}</div>
        ) : files.length === 0 ? (
          <div style={{ padding: "10px", fontSize: 12, color: "var(--ink-3)" }}>No files found</div>
        ) : (
          <div style={{ overflowY: "auto", maxHeight: 600 }}>
            {renderTree(tree)}
          </div>
        )}
      </div>

      {/* Editor pane */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Toolbar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12.5, color: "var(--ink-3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selectedPath ?? "Select a file to edit"}
          </span>
          {saveMsg === "saved" && (
            <span style={{ fontSize: 12, color: "var(--ok)", display: "flex", alignItems: "center", gap: 4 }}>
              <Check style={{ width: 12, height: 12 }} /> Saved
            </span>
          )}
          {saveMsg === "error" && (
            <span style={{ fontSize: 12, color: "var(--err)", display: "flex", alignItems: "center", gap: 4 }}>
              <AlertTriangle style={{ width: 12, height: 12 }} /> Save failed
            </span>
          )}
          <button
            className="btn"
            onClick={() => void handleDelete()}
            disabled={!selectedPath || deleting}
            style={{ fontSize: 12, padding: "4px 10px", display: "flex", alignItems: "center", gap: 5 }}
          >
            {deleting
              ? <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} />
              : <Trash2 style={{ width: 12, height: 12 }} />
            }
            Delete
          </button>
          <button
            className="btn accent"
            onClick={() => void handleSave()}
            disabled={!selectedPath || saving}
            style={{ fontSize: 12, padding: "4px 10px", display: "flex", alignItems: "center", gap: 5 }}
          >
            {saving
              ? <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} />
              : <Save style={{ width: 12, height: 12 }} />
            }
            Save
          </button>
        </div>

        {/* Textarea */}
        <div style={{ position: "relative" }}>
          {loadingFile && (
            <div style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
              background: "var(--surface)", opacity: 0.8, borderRadius: 0, zIndex: 1,
            }}>
              <Loader2 style={{ width: 20, height: 20, animation: "spin 1s linear infinite", color: "var(--ink-3)" }} />
            </div>
          )}
          <textarea
            value={content}
            onChange={(e) => { setContent(e.target.value); setSaveMsg(null); }}
            disabled={!selectedPath}
            placeholder={selectedPath ? "" : "Select a file from the tree, or create a new one with + above."}
            style={{
              width: "100%",
              minHeight: 520,
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 13,
              lineHeight: 1.6,
              padding: "14px 16px",
              border: "1px solid var(--line)",
              borderRadius: 0,
              background: "var(--surface)",
              color: "var(--ink)",
              resize: "vertical",
              boxSizing: "border-box",
              outline: "none",
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Sync tab ─────────────────────────────────────────────────────────────────

function SyncTab({ initialRuns, vaultDocs }: { initialRuns: VaultRun[]; vaultDocs: VaultDoc[] }) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ runId: string } | "error" | null>(null);

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
        body: JSON.stringify({ repoOwner: "LumitureLabs", repoName: "LumiKnowledge" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSyncResult(await res.json() as { runId: string });
    } catch {
      setSyncResult("error");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button className="btn accent" onClick={() => void handleManualSync()} disabled={syncing}>
          {syncing
            ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Syncing…</>
            : <><RefreshCw style={{ width: 13, height: 13 }} /> Sync now</>
          }
        </button>
      </div>

      {syncResult && syncResult !== "error" && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 14px", borderRadius: 0, marginBottom: 20,
          background: "var(--ok-soft, oklch(97% 0.02 145))",
          border: "1px solid oklch(88% 0.06 145)",
          fontSize: 13, color: "var(--ok)",
        }}>
          <Check style={{ width: 13, height: 13 }} />
          Full sync started · <a href={`/runs/${syncResult.runId}`} style={{ color: "var(--accent)", textDecoration: "underline" }}>view run</a>
        </div>
      )}
      {syncResult === "error" && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 14px", borderRadius: 0, marginBottom: 20,
          background: "var(--err-soft)", border: "1px solid var(--err-line)",
          fontSize: 13, color: "var(--err)",
        }}>
          <AlertTriangle style={{ width: 13, height: 13 }} /> Sync failed. Check runtime logs.
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
          value={lastRun ? capitalize(lastRun.status) : "-"}
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
                No syncs yet. Push a note to LumiKnowledge to trigger the first one.
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
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

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
