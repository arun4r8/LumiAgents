"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

/**
 * First-run moments (#71). Two variants share one component and one dismissal
 * mechanism:
 *
 *  M1  — the enduser welcome on the enduser landing (/agents).
 *  M13 — the ops first-run line on Overview.
 *
 * Dismissal persists to `user_metadata.onboarded_at` via
 * `supabase.auth.updateUser({ data: { onboarded_at } })` — deliberately NOT
 * localStorage, which is per-device and would re-show the welcome in every new
 * browser. The topbar's "Replay the welcome" clears the same field.
 *
 * The server decides whether to render this at all (role + onboarded_at), so
 * there is no flash of a note that was already dismissed.
 */

interface Props {
  variant: "welcome" | "line";
  title?: string;
  body: string;
  dismissLabel?: string;
}

export function FirstRunNote({ variant, title, body, dismissLabel = "Got it" }: Props) {
  const [gone, setGone] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (gone) return null;

  function dismiss() {
    setGone(true);
    startTransition(async () => {
      const supabase = createClient();
      await supabase.auth.updateUser({ data: { onboarded_at: new Date().toISOString() } });
      router.refresh();
    });
  }

  if (variant === "line") {
    return (
      <div className="first-run-line" role="note">
        <span>{body}</span>
        <button type="button" onClick={dismiss} disabled={pending} className="first-run-dismiss">
          {dismissLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="first-run-card" role="note">
      <button
        type="button"
        className="first-run-x"
        onClick={dismiss}
        disabled={pending}
        aria-label="Dismiss"
      >
        <X />
      </button>
      {title && <h2 className="first-run-title">{title}</h2>}
      <p className="first-run-body">{body}</p>
      <button type="button" onClick={dismiss} disabled={pending} className="btn primary first-run-cta">
        {dismissLabel}
      </button>
    </div>
  );
}

export default FirstRunNote;
