"use client";

import { useTheme } from "@/components/theme-provider";
import { Sun, Moon, Monitor, AlignJustify, Rows3 } from "lucide-react";

interface Props {
  userEmail: string;
  userRole: string;
  userCreatedAt: string | null;
}

export function SettingsClient({ userEmail, userRole, userCreatedAt }: Props) {
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
