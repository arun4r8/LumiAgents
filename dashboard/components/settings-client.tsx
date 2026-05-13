"use client";

import { useTheme } from "@/components/theme-provider";
import { Sun, Moon, Monitor, AlignJustify, Rows3, RefreshCw, Loader2, Check, AlertTriangle } from "lucide-react";
import { useTransition, useState } from "react";

interface Props {
  userEmail: string;
  userRole: string;
  userCreatedAt: string | null;
  triggerVaultSync: (formData: FormData) => Promise<void>;
}

export function SettingsClient({ userEmail, userRole, userCreatedAt, triggerVaultSync }: Props) {
  const { theme, density, setTheme, setDensity } = useTheme();

  const memberSince = userCreatedAt
    ? new Date(userCreatedAt).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : null;

  return (
    <div className="page view-fade" style={{ maxWidth: 620 }}>
      <div className="page-h">
        <div>
          <h1>Settings</h1>
          <div className="sub">Preferences are saved locally to this browser.</div>
        </div>
      </div>

      {/* ── Account ───────────────────────────────────────────── */}
      <section className="settings-section">
        <h3 className="settings-heading">Account</h3>
        <div className="card" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <SettingsRow label="Email">
            <span className="mono" style={{ fontSize: 13 }}>{userEmail}</span>
          </SettingsRow>
          <Divider />
          <SettingsRow label="Role">
            <span className="chip" style={{ textTransform: "capitalize" }}>{userRole}</span>
          </SettingsRow>
          {memberSince && (
            <>
              <Divider />
              <SettingsRow label="Member since">
                <span style={{ fontSize: 13, color: "var(--ink-2)" }}>{memberSince}</span>
              </SettingsRow>
            </>
          )}
        </div>
      </section>

      {/* ── Appearance ────────────────────────────────────────── */}
      <section className="settings-section">
        <h3 className="settings-heading">Appearance</h3>
        <div className="card" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          <SettingsRow label="Theme" sub="Choose light, dark, or follow the OS setting.">
            <div className="seg-ctrl">
              <SegBtn
                active={theme === "light"}
                onClick={() => setTheme("light")}
                icon={<Sun style={{ width: 13, height: 13 }} />}
                label="Light"
              />
              <SegBtn
                active={theme === "dark"}
                onClick={() => setTheme("dark")}
                icon={<Moon style={{ width: 13, height: 13 }} />}
                label="Dark"
              />
              <SegBtn
                active={theme === "system"}
                onClick={() => setTheme("system")}
                icon={<Monitor style={{ width: 13, height: 13 }} />}
                label="System"
              />
            </div>
          </SettingsRow>

          <Divider />

          <SettingsRow label="Density" sub="Compact reduces spacing for information-dense views.">
            <div className="seg-ctrl">
              <SegBtn
                active={density === "default"}
                onClick={() => setDensity("default")}
                icon={<AlignJustify style={{ width: 13, height: 13 }} />}
                label="Default"
              />
              <SegBtn
                active={density === "compact"}
                onClick={() => setDensity("compact")}
                icon={<Rows3 style={{ width: 13, height: 13 }} />}
                label="Compact"
              />
            </div>
          </SettingsRow>
        </div>
      </section>

      {/* ── Vault ─────────────────────────────────────────────── */}
      <VaultSyncSection triggerVaultSync={triggerVaultSync} />

      {/* ── About ─────────────────────────────────────────────── */}
      <section className="settings-section">
        <h3 className="settings-heading">About</h3>
        <div className="card" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <SettingsRow label="Platform">
            <span style={{ fontSize: 13, color: "var(--ink-2)" }}>LumiAgents · Internal ops dashboard</span>
          </SettingsRow>
          <Divider />
          <SettingsRow label="Runtime">
            <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Cloudflare Workers + Workflows</span>
          </SettingsRow>
          <Divider />
          <SettingsRow label="Data layer">
            <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Supabase (Postgres + RLS)</span>
          </SettingsRow>
        </div>
      </section>

      <style>{`
        .settings-section { margin-bottom: 28px; }
        .settings-heading {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: .06em;
          text-transform: uppercase;
          color: var(--ink-3);
          margin-bottom: 8px;
        }
        .seg-ctrl {
          display: flex;
          gap: 4px;
          background: var(--surface-2, var(--bg-2));
          border: 1px solid var(--line);
          border-radius: 8px;
          padding: 3px;
        }
        .seg-btn {
          display: flex;
          align-items: center;
          gap: 5px;
          padding: 5px 11px;
          border-radius: 5px;
          border: none;
          background: transparent;
          color: var(--ink-2);
          font-size: 12.5px;
          font-weight: 500;
          cursor: pointer;
          transition: background 120ms, color 120ms;
          white-space: nowrap;
        }
        .seg-btn:hover { color: var(--ink); }
        .seg-btn.active {
          background: var(--bg);
          color: var(--ink);
          box-shadow: 0 1px 3px oklch(0% 0 0 / .10);
        }
        .settings-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
        }
        .settings-row-label { font-size: 13.5px; font-weight: 500; color: var(--ink); line-height: 1.4; }
        .settings-row-sub { font-size: 12px; color: var(--ink-3); margin-top: 2px; }
        .settings-divider { border: none; border-top: 1px solid var(--line); margin: 0; }
      `}</style>
    </div>
  );
}

function SettingsRow({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-label">{label}</div>
        {sub && <div className="settings-row-sub">{sub}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function SegBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button className={`seg-btn${active ? " active" : ""}`} onClick={onClick} type="button">
      {icon}
      {label}
    </button>
  );
}

function Divider() {
  return <hr className="settings-divider" />;
}

function VaultSyncSection({ triggerVaultSync }: { triggerVaultSync: (fd: FormData) => Promise<void> }) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "ok" | "err">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setStatus("idle"); setErrMsg(null);
    startTransition(async () => {
      try {
        await triggerVaultSync(fd);
        setStatus("ok");
        setTimeout(() => setStatus("idle"), 4000);
      } catch (err) {
        setErrMsg(err instanceof Error ? err.message : "Sync failed");
        setStatus("err");
      }
    });
  }

  return (
    <section className="settings-section">
      <h3 className="settings-heading">Vault sync</h3>
      <form onSubmit={handleSubmit} className="card" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 4, display: "block" }}>GitHub owner</label>
            <input className="input" name="repoOwner" placeholder="e.g. arun4r8" required style={{ height: 34, fontSize: 13 }} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 4, display: "block" }}>Repository name</label>
            <input className="input" name="repoName" placeholder="e.g. lumiture-vault" required style={{ height: 34, fontSize: 13 }} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 4, display: "block" }}>Branch <span style={{ color: "var(--ink-3)" }}>(optional)</span></label>
            <input className="input" name="branch" placeholder="main" style={{ height: 34, fontSize: 13 }} />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" }}>
          <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
            Triggers the patch/vault-sync orchestration to pull the latest vault contents into the document corpus.
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {status === "ok" && (
              <span className="chip ok" style={{ fontSize: 12 }}>
                <Check style={{ width: 10, height: 10 }} /> Sync dispatched
              </span>
            )}
            {status === "err" && errMsg && (
              <span style={{ fontSize: 12, color: "var(--err)", display: "flex", alignItems: "center", gap: 5 }}>
                <AlertTriangle style={{ width: 12, height: 12 }} /> {errMsg}
              </span>
            )}
            <button type="submit" className="btn" disabled={pending} style={{ whiteSpace: "nowrap" }}>
              {pending
                ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Syncing…</>
                : <><RefreshCw style={{ width: 13, height: 13 }} /> Sync now</>}
            </button>
          </div>
        </div>
      </form>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </section>
  );
}
