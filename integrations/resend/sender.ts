import type { Env } from "../../runtime/src/types";

// Per-agent "from" identities. Each agent's emails go out as e.g.
// "Beady <beady@yourdomain.com>", reusing whatever verified domain RESEND_FROM
// already points at (Resend allows any local part on a verified domain). If
// RESEND_FROM is unset or still on the Resend test domain (resend.dev, which only
// permits onboarding@resend.dev), we fall back to the shared sender so nothing breaks.

const DEFAULT_FROM = "LumiAgents <onboarding@resend.dev>";

const AGENT_SENDER: Record<string, { name: string; local: string }> = {
  angie: { name: "Angie", local: "angie" },
  beady: { name: "Beady", local: "beady" },
  cleo:  { name: "Cleo",  local: "cleo" },
  dewey: { name: "Dewey", local: "dewey" },
  money: { name: "Money", local: "money" },
  patch: { name: "Patch", local: "patch" },
};

function domainOf(from: string | undefined): string | null {
  if (!from) return null;
  const m = from.match(/<[^@>]+@([^>]+)>/) ?? from.match(/@([^\s>]+)/);
  return m && m[1] ? m[1].trim().toLowerCase() : null;
}

// Resolve the "from" line for an agent. Returns a verified per-agent address when
// possible, else the shared RESEND_FROM (or the default).
export function senderFor(env: Env, slug: string): string {
  const cfg = AGENT_SENDER[slug];
  const domain = domainOf(env.RESEND_FROM);
  if (cfg && domain && domain !== "resend.dev") {
    return `${cfg.name} <${cfg.local}@${domain}>`;
  }
  return env.RESEND_FROM ?? DEFAULT_FROM;
}
