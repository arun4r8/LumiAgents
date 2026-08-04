## What & why

<!-- One or two sentences. Link the issue: Closes #NNN -->

## Checklist

- [ ] **Tested on staging** — or, if this is the change that will be validated on staging after merge, say so here. (`main` auto-deploys to staging; production is a separate manual promotion.)
- [ ] **Migrations are forward-only** — no edits to an applied migration; new schema ships with its RLS policy in the same file.
- [ ] **No secrets in code** — new config goes to `wrangler secret put` (Workers) or GitHub Actions secrets, never into a committed file.
- [ ] **Docs updated** — `docs/` reflects any change to architecture, data model, workflow contract, auth model, or environments.

## Production promotion

<!-- Delete if not applicable. -->
Requires a prod promote after merge: Actions → **Deploy Worker (PRODUCTION — manual)** / **Deploy Dashboard (PRODUCTION — manual)** → Run workflow. See `docs/environments.md`.
