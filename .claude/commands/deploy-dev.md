---
description: Deploy the runtime + dashboard to the dev environment and run smoke checks
---

Deploy to dev. Steps:

1. Confirm the user's git working tree is clean (`git status`). If not, ask whether to proceed.
2. Run `pnpm test` and `pnpm typecheck`. Block on failure.
3. Apply pending migrations against the dev Supabase project: `pnpm db:migrate --env dev`. Report what was applied.
4. Deploy the runtime Worker: `pnpm wrangler deploy --env dev`.
5. Deploy the dashboard: `pnpm pages:deploy --env dev`.
6. Run smoke tests: `pnpm smoke --env dev`.
7. Print: dev URLs, what was deployed (commit SHA), and any warnings from the smoke run.

If any step fails, stop and report. Do not retry deploys silently.
