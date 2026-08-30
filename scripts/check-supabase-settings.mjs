#!/usr/bin/env node
// ============================================================================
// check-supabase-settings.mjs  (issue #140)
//
// WHAT THIS IS
//   An assertion check over the Supabase *project settings* that live only in
//   the Supabase dashboard: they are invisible to this repository, are never
//   created by `supabase db push`, and every one of them fails in a way that
//   reads as a data or code bug rather than a settings bug.
//
//   `docs/environments.md` documents what they should be. Documentation helps
//   the person who reads it; it detects nothing. This script detects.
//
// WHAT IT DOES NOT DO
//   It never writes. A drifted setting is reported, not repaired -- flipping
//   auth configuration from CI is exactly the sort of unattended change this
//   check exists to catch.
//
// USAGE
//   SUPABASE_ACCESS_TOKEN=<management-api-pat> node scripts/check-supabase-settings.mjs
//   ... --json     machine-readable output
//
//   Locally the token is in the keychain:
//     SUPABASE_ACCESS_TOKEN=$(security find-generic-password -s supabase-mgmt -a lumi -w) \
//       node scripts/check-supabase-settings.mjs
//
// EXIT CODES
//   0 = every setting matches intent
//   1 = at least one drifted (or a project could not be read)
//   2 = bad invocation (no token)
// ============================================================================

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const JSON_OUT = process.argv.includes("--json");

if (!TOKEN) {
  console.error("SUPABASE_ACCESS_TOKEN is not set. See the header of this file.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Expected values, keyed by project ref.
//
// These are not defaults -- every one of them differs from what a brand-new
// Supabase project ships with, which is the entire reason this file exists.
// Only the URLs differ between environments; the security posture is identical.
// ---------------------------------------------------------------------------
const DASHBOARD = {
  production: "https://lumiagents-dashboard.lumiture.workers.dev",
  staging: "https://lumiagents-dashboard-staging.lumiture.workers.dev",
};

const PROJECTS = [
  { env: "production", ref: "cuaknazkpmwvnkmwtamp", url: DASHBOARD.production },
  { env: "staging", ref: "efxjgtunwiljmwaezxve", url: DASHBOARD.staging },
];

/**
 * Each check carries `why` -- the failure mode if the setting drifts. A red
 * build that only says `disable_signup: expected true, got false` makes the
 * reader go and find out why it matters; this way the build tells them.
 */
function expectationsFor({ url }) {
  return [
    {
      key: "disable_signup",
      api: "auth",
      expected: true,
      why: "LumiAgents is invite-only. Open signup lets anyone holding the anon key create an account. Fails silently -- nothing looks wrong.",
    },
    {
      key: "site_url",
      api: "auth",
      expected: url,
      why: "Invite and password-reset links are built from this. A wrong value points them at localhost and the redirect is refused.",
    },
    {
      key: "uri_allow_list",
      api: "auth",
      expected: `${url}/**,http://localhost:3000/**`,
      why: "Redirect targets are rejected unless listed. An empty list makes every invite link resolve to an error.",
    },
    {
      key: "mailer_otp_exp",
      api: "auth",
      expected: 86400,
      why: "With no SMTP, invites are copy-paste links pasted into chat and routinely outlive the 1h default. The invitee lands on /login with no explanation and verifyOtp fails silently.",
    },
    {
      key: "hook_custom_access_token_enabled",
      api: "auth",
      expected: true,
      why: "No hook means no user_role claim, so is_ops() is false for everyone: login succeeds and the entire app is empty.",
    },
    {
      key: "hook_custom_access_token_uri",
      api: "auth",
      expected: "pg-functions://postgres/public/custom_access_token_hook",
      why: "The hook must point at the function the migrations define. Enabled-but-misrouted is indistinguishable from off.",
    },
    {
      key: "db_schema",
      api: "postgrest",
      // Compared as a set, not a string -- see normalise() below.
      expected: ["public", "graphql_public", "orchestration"],
      why: "Essentially the whole platform lives in `orchestration`. Unexposed, every dashboard and runtime query returns PGRST106: the database is fine, the API refuses to serve it.",
    },
  ];
}

async function fetchConfig(ref, api) {
  const path = api === "auth" ? "config/auth" : "postgrest";
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/projects/${ref}/${path} -> ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * `db_schema` comes back as a comma-separated string whose spacing and order
 * are not guaranteed by the API. Comparing it literally would produce a red
 * build over a cosmetic reordering someone never made, so it is compared as a
 * set. Every other value is compared strictly.
 */
function normalise(expected, actual) {
  if (!Array.isArray(expected)) return { ok: expected === actual, shown: actual };
  const got = String(actual ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = expected.filter((s) => !got.includes(s));
  return { ok: missing.length === 0, shown: got.join(", "), missing };
}

const results = [];
let failed = 0;

for (const project of PROJECTS) {
  let config;
  try {
    const [auth, postgrest] = await Promise.all([
      fetchConfig(project.ref, "auth"),
      fetchConfig(project.ref, "postgrest"),
    ]);
    config = { auth, postgrest };
  } catch (err) {
    failed++;
    results.push({ env: project.env, ref: project.ref, error: String(err.message ?? err) });
    continue;
  }

  for (const check of expectationsFor(project)) {
    const actual = config[check.api][check.key];
    const { ok, shown, missing } = normalise(check.expected, actual);
    if (!ok) failed++;
    results.push({
      env: project.env,
      ref: project.ref,
      key: check.key,
      ok,
      expected: Array.isArray(check.expected) ? check.expected.join(", ") : check.expected,
      actual: shown,
      missing,
      why: check.why,
    });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failed === 0, results }, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

for (const project of PROJECTS) {
  const rows = results.filter((r) => r.env === project.env);
  console.log(`\n${project.env}  (${project.ref})`);
  console.log("─".repeat(72));
  for (const r of rows) {
    if (r.error) {
      console.log(`  ✗  could not read project: ${r.error}`);
      continue;
    }
    console.log(`  ${r.ok ? "✓" : "✗"}  ${r.key} = ${JSON.stringify(r.actual)}`);
    if (!r.ok) {
      console.log(`       expected: ${JSON.stringify(r.expected)}`);
      if (r.missing?.length) console.log(`       missing:  ${r.missing.join(", ")}`);
      console.log(`       impact:   ${r.why}`);
    }
  }
}

console.log("");
if (failed === 0) {
  console.log("All Supabase project settings match intent.");
} else {
  console.log(`${failed} setting(s) drifted from intent.`);
  console.log("Fix in the Supabase dashboard (Authentication → URL Configuration / Sign In,");
  console.log("Settings → API → Exposed schemas, Authentication → Hooks), then re-run.");
  console.log("Reference: docs/environments.md");
}
process.exit(failed === 0 ? 0 : 1);
