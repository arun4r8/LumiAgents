"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { roleOf } from "@/lib/role";
import { useRouter } from "next/navigation";
import { Loader2, Check } from "lucide-react";

export default function AcceptPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = password.length >= 6 && password === confirm && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // Land by role, exactly as login and the root redirect do. Endusers cannot see
    // /overview (ops-only, and RLS empties it), so sending a freshly-invited enduser
    // there made the first screen of the product a blank page with no way back.
    const { data: { user } } = await supabase.auth.getUser();
    router.push(roleOf(user) === "ops" ? "/overview" : "/agents");
    router.refresh();
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        {/* Brand */}
        <div className="login-brand">
          <div className="brand row gap-sm" style={{ padding: 0 }}>
            <div className="brand-mark" aria-hidden="true">L</div>
            <span className="brand-name">Lumi<em>Agents</em></span>
          </div>
        </div>

        <div>
          <h2>Welcome to LumiAgents</h2>
          <div className="sb">Set a password to finish setting up your account.</div>
        </div>

        <form onSubmit={handleSubmit} className="login-fields">
          <div className="field">
            <label htmlFor="password">
              New password{" "}
              <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>(min 6 characters)</span>
            </label>
            <input
              id="password"
              className="input"
              type="password"
              autoFocus
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="confirm">Confirm password</label>
            <input
              id="confirm"
              className="input"
              type="password"
              placeholder="••••••••"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              style={{ borderColor: mismatch ? "var(--err)" : undefined }}
            />
            {mismatch && (
              <div style={{ fontSize: 12, color: "var(--err)", marginTop: 4 }}>
                Passwords don&apos;t match
              </div>
            )}
          </div>

          {error && (
            <div style={{ fontSize: 12.5, color: "var(--err)" }}>{error}</div>
          )}

          <button
            type="submit"
            className="btn primary"
            disabled={!canSubmit}
            style={{ height: 38, justifyContent: "center" }}
          >
            {loading ? (
              <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Saving…</>
            ) : (
              <><Check style={{ width: 13, height: 13 }} /> Set password &amp; continue</>
            )}
          </button>
        </form>

        <div className="helper">Your account is invite-only · contact ops@lumiture.com</div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
