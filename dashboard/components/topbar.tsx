"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sun, Moon, HelpCircle, X } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { createClient } from "@/lib/supabase/client";

/**
 * Topbar — 52px, sticky, bottom hairline. Left: the breadcrumb for the current
 * route. Right: a ⌘K search affordance (deliberately a visual affordance only —
 * there is no search to open yet), a theme toggle, and the ? help panel.
 *
 * The theme toggle goes through the SAME mechanism as the Settings appearance
 * control: `useTheme()` from components/theme-provider, which writes the
 * `lumi-theme` localStorage key and the `data-theme` attribute that
 * app/layout.tsx's pre-paint script reads. There is no second mechanism.
 */

// Route → breadcrumb. Longest prefix wins, so /runs/<id> inherits Operations/Runs.
const CRUMBS: Array<[string, string[]]> = [
  ["/overview", ["Overview"]],
  ["/agents/new", ["Agents", "New agent"]],
  ["/agents", ["Agents"]],
  ["/runs", ["Operations", "Runs"]],
  ["/approvals", ["Operations", "Approvals"]],
  ["/orchestrations", ["Operations", "Orchestrations"]],
  ["/schedules", ["Operations", "Schedules"]],
  ["/records/bd", ["Records", "BD Pipeline"]],
  ["/records/content", ["Records", "Content"]],
  ["/records/talent", ["Records", "Talent"]],
  ["/records/data", ["Records", "Data"]],
  ["/knowledge", ["Knowledge", "Library"]],
  ["/memory", ["Knowledge", "Memory"]],
  ["/settings", ["System", "Settings"]],
  ["/infrastructure", ["System", "Infrastructure"]],
];

function crumbsFor(pathname: string): string[] {
  let best: string[] = ["LumiAgents"];
  let bestLen = -1;
  for (const [prefix, labels] of CRUMBS) {
    if ((pathname === prefix || pathname.startsWith(`${prefix}/`)) && prefix.length > bestLen) {
      best = labels;
      bestLen = prefix.length;
    }
  }
  return best;
}

function subscribeSystemDark(onChange: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getSystemDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export default function Topbar({ isOps = false }: { isOps?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [helpOpen, setHelpOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const crumbs = crumbsFor(pathname);

  // "system" resolves against the OS preference so the toggle always flips to
  // the opposite of what is on screen. Server snapshot is `false` — the toggle
  // only labels itself, so a first-paint guess costs nothing.
  const systemDark = useSyncExternalStore(subscribeSystemDark, getSystemDark, () => false);

  const isDark = theme === "dark" || (theme === "system" && systemDark);
  const next = isDark ? "light" : "dark";

  // Close the help panel on Escape / outside click.
  useEffect(() => {
    if (!helpOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setHelpOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setHelpOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [helpOpen]);

  // Replay the welcome: clear the onboarding stamp in user_metadata (the same
  // field the first-run notes write), then refresh so the note comes back.
  const replayWelcome = useCallback(async () => {
    setResetting(true);
    try {
      const supabase = createClient();
      await supabase.auth.updateUser({ data: { onboarded_at: null } });
      setHelpOpen(false);
      router.refresh();
    } finally {
      setResetting(false);
    }
  }, [router]);

  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <span key={`${c}-${i}`} className={i === crumbs.length - 1 ? "here" : undefined}>
            {i > 0 && <span className="sep" aria-hidden="true">/</span>}
            {c}
          </span>
        ))}
      </nav>

      <div className="spacer" />

      {/* Visual affordance only — search is not built yet, so this is inert and
          hidden from assistive tech rather than pretending to be a control. */}
      <div className="search-pill" aria-hidden="true">
        <span>Search or command</span>
        <span className="kbd">⌘K</span>
      </div>

      <button
        type="button"
        className="topbar-btn"
        onClick={() => setTheme(next)}
        aria-label={`Switch to ${next} theme`}
        title={`Switch to ${next} theme`}
      >
        {isDark ? <Sun /> : <Moon />}
        <span>{next === "light" ? "Light" : "Dark"}</span>
      </button>

      <div className="help-wrap" ref={panelRef}>
        <button
          type="button"
          className="topbar-btn icon-only"
          onClick={() => setHelpOpen((v) => !v)}
          aria-expanded={helpOpen}
          aria-label="Help"
          title="Help"
        >
          <HelpCircle />
        </button>

        {helpOpen && (
          <div className="help-panel" role="dialog" aria-label="Help">
            <div className="help-head">
              <span>How LumiAgents works</span>
              <button type="button" className="help-close" onClick={() => setHelpOpen(false)} aria-label="Close help">
                <X />
              </button>
            </div>

            {/* Role-aware: an enduser has no Approvals, Records, Overview or
                Infrastructure in their nav, so describing them would be explaining
                features they cannot see. Each section below is only shown to a role
                that actually has that surface. */}
            <section className="help-sect">
              <h4>Agents</h4>
              <p>Each agent covers a domain: recruiting, business development, finance. Open one and say what you need in plain language; it works out which of its tools to use.</p>
            </section>
            <section className="help-sect">
              <h4>Orchestrations</h4>
              <p>The individual jobs an agent knows how to run. Ask an agent and it picks one for you, or start one here directly if you already know what you want.</p>
            </section>
            <section className="help-sect">
              <h4>Runs</h4>
              <p>When an agent does something, it creates a run: a step-by-step record of what happened and what came back.{isOps ? " Runs lists every run in the fleet." : " Runs lists the ones you started."}</p>
            </section>
            {isOps && (
              <section className="help-sect">
                <h4>Approvals</h4>
                <p>Some runs pause for a human decision and wait here, with a count in the nav. Not all of them do. A few orchestrations write to Jira, email or the content calendar directly, so treat the pause as a feature of those runs rather than a guarantee.</p>
              </section>
            )}
            <section className="help-sect">
              <h4>Library</h4>
              <p>The documents the agents can search. Anything you upload here becomes searchable by the agents you talk to.</p>
            </section>
            {isOps && (
              <section className="help-sect">
                <h4>Records</h4>
                <p>The business tables the agents read and write: awards, industry days, RFI drafts, the content calendar, people. Same data the agents see, shown directly.</p>
              </section>
            )}

            <button type="button" className="help-replay" onClick={replayWelcome} disabled={resetting}>
              {resetting ? "Resetting…" : "Replay the welcome"}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
