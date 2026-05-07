"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.push("/overview");
    router.refresh();
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        {/* Brand */}
        <div className="login-brand">
          <div className="brand row gap-sm" style={{ padding: 0 }}>
            <div className="brand-mark" />
            <span className="brand-name">Lumi<em>Agents</em></span>
          </div>
        </div>

        <div>
          <h2>Sign in</h2>
          <div className="sb">Internal AI orchestration · ops only</div>
        </div>

        <form onSubmit={handleLogin} className="login-fields">
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              autoFocus
              placeholder="you@lumiture.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && (
            <div style={{ fontSize: 12.5, color: "var(--err)" }}>{error}</div>
          )}

          <button
            type="submit"
            className="btn primary"
            disabled={loading}
            style={{ height: 38, justifyContent: "center" }}
          >
            {loading
              ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Signing in…</>
              : "Continue"}
          </button>
        </form>

        <div className="helper">SSO via Okta available · contact ops@lumiture.com</div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
