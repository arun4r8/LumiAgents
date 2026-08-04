// Tier 2 agent builder (#67) — Build 2 shared safety guards.
//
// Build 2 broadens codegen from ONE artifact kind (a new orchestration) to two more (a new
// domain table and a new dedicated-Worker agent). Both riskier kinds are only acceptable because
// (a) everything ships as a PR a human reviews + merges (no auto-merge anywhere), and (b) the
// generated artifacts are mechanically screened here before they ever reach a PR:
//   - generated SQL must be forward-only / non-destructive (no DROP/TRUNCATE/DELETE, no
//     destructive ALTER — the sole permitted ALTER is `ENABLE ROW LEVEL SECURITY`, which every
//     new table needs and which cannot destroy data);
//   - no generated file may inline a secret VALUE (secrets are referenced by NAME only, and the
//     ops runbook provisions the value out-of-band).
//
// These are pure, network-free, and unit-tested. They are a defense-in-depth backstop; human
// review remains the hard gate.

import { Tier2ValidationError } from "./generate";

// ─── Destructive-SQL guard ──────────────────────────────────────────────────────

/** Strip whole-line SQL comments so a rollback note in a `-- ...` comment never trips a guard. */
export function executableSql(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim().length > 0) ?? s).trim().slice(0, 120);
}

/**
 * Assert the generated migration is forward-only and non-destructive. Judges each statement by its
 * leading COMMAND keyword (so a GRANT that merely names the DELETE privilege, or a column named
 * "…drop…", is not mistaken for a destructive statement): rejects any statement whose command is
 * DROP / TRUNCATE / DELETE, and any ALTER other than the non-destructive `ALTER TABLE ... ENABLE
 * ROW LEVEL SECURITY` (the one ALTER a new-table migration legitimately needs — RLS cannot be
 * enabled inside CREATE TABLE). Throws Tier2ValidationError so the route maps it to a 400.
 * Comments (incl. the rollback note) are exempt.
 */
export function assertNoDestructiveSql(sql: string): void {
  const statements = executableSql(sql).split(";");
  for (const raw of statements) {
    const s = raw.trim();
    if (!s) continue;
    const command = (/^([a-zA-Z]+)/.exec(s)?.[1] ?? "").toUpperCase();
    if (command === "DROP" || command === "TRUNCATE" || command === "DELETE") {
      throw new Tier2ValidationError([`Generated SQL contains a destructive ${command} statement: "${firstLine(s)}"`]);
    }
    if (command === "ALTER" && !/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(s)) {
      throw new Tier2ValidationError([`Generated SQL contains a non-RLS ALTER (not allowed): "${firstLine(s)}"`]);
    }
  }
}

// ─── Inline-secret guard ─────────────────────────────────────────────────────────

// A generated file may MENTION a secret name (e.g. "provision SALES_SCOUT_API_KEY out-of-band")
// but must never carry a secret VALUE. These patterns catch NAME = "value" assignments and the
// common shapes of real credential values, while leaving bare NAME references alone.
const SECRET_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\b[A-Za-z0-9_]*(?:API_KEY|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN|CLIENT_SECRET)\b\s*[:=]\s*["'`][^"'`]+["'`]/i,
    what: "an inline secret assignment (NAME = value)" },
  { re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, what: "a private key block" },
  { re: /\bBearer\s+[A-Za-z0-9._\-]{16,}/, what: "an inline bearer token" },
  { re: /\bsk-[A-Za-z0-9]{16,}\b/, what: "an API secret token (sk-…)" },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/, what: "a GitHub token (ghp_…)" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: "an AWS access key id" },
];

/**
 * Assert a generated file carries no inline secret VALUE. Throws Tier2ValidationError naming the
 * file so the route maps it to a 400. Secret NAMES (for the ops runbook / PR review note) are fine.
 */
export function assertNoInlineSecrets(content: string, label: string): void {
  for (const { re, what } of SECRET_PATTERNS) {
    if (re.test(content)) {
      throw new Tier2ValidationError([`Generated file ${label} appears to contain ${what}; secrets must be referenced by NAME only.`]);
    }
  }
}
