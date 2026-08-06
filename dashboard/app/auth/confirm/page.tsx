"use client";

import { useState } from "react";
import { use } from "react";
import { Loader2, ArrowRight } from "lucide-react";
import { confirmOtp } from "./actions";

/**
 * Invite / recovery interstitial.
 *
 * This URL used to be a GET route handler that verified the OTP immediately.
 * That made the link single-use by anything that merely FETCHED it — chat
 * unfurlers and mail-security scanners spend tokens seconds after they are
 * generated, long before the human clicks. See ./actions.ts for the incident.
 *
 * So the page now renders and waits. Verification happens only when someone
 * presses Continue, which submits a POST. The token is untouched until then.
 *
 * The page deliberately shows nothing about the invited account — the token
 * hash is already in the URL, and echoing an email address here would hand a
 * link-scanner's logs (and anyone with the URL) a confirmed address for free.
 */
export default function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; type?: string; next?: string }>;
}) {
  const params = use(searchParams);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const tokenHash = params.token_hash ?? "";
  const type = params.type ?? "";
  const next = params.next ?? "/accept";
  const usable = Boolean(tokenHash && type);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!usable || pending) return;
    setPending(true);
    setError(null);

    const fd = new FormData();
    fd.set("token_hash", tokenHash);
    fd.set("type", type);
    fd.set("next", next);

    // On success the action redirects and this never resolves; only failures
    // come back with a message.
    const result = await confirmOtp(fd);
    setError(result?.error ?? "Something went wrong. Ask for a new invite.");
    setPending(false);
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand row gap-sm" style={{ padding: 0 }}>
            <div className="brand-mark" aria-hidden="true">L</div>
            <span className="brand-name">Lumi<em>Agents</em></span>
          </div>
        </div>

        <div>
          <h2>{type === "recovery" ? "Reset your password" : "You have been invited"}</h2>
          <div className="sb">
            {usable
              ? "Press continue to confirm it is really you."
              : "This link is incomplete. Ask for a new invite."}
          </div>
        </div>

        <form onSubmit={onSubmit} className="login-fields">
          {error && <div style={{ fontSize: 12.5, color: "var(--err)" }}>{error}</div>}

          <button
            type="submit"
            className="btn primary"
            disabled={!usable || pending}
            style={{ height: 38, justifyContent: "center" }}
          >
            {pending ? (
              <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Confirming…</>
            ) : (
              <>Continue <ArrowRight style={{ width: 13, height: 13 }} /></>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
