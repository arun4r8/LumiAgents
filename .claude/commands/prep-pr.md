---
description: Prepare a PR with the right description, checklist, and reviewers
---

Prepare a PR for the current branch. Steps:

1. Diff against `main`: `git diff main...HEAD --stat` and read the changed files.
2. Categorize the change: orchestration / integration / runtime / schema / dashboard / docs / mixed.
3. Draft a PR description with these sections:

```
## What
<one paragraph>

## Why
<one paragraph; link to issue if exists>

## How
<bullet list of the substantive changes>

## Migration story
<if schema changed: how existing runs/data are affected. otherwise: "No migration impact.">

## Test plan
<what was tested locally; what reviewer should verify>

## Screenshots / smoke run
<for dashboard changes, screenshots. for orchestration changes, link to dev smoke run.>

## Checklist
- [ ] Tests added/updated
- [ ] Lint + typecheck clean
- [ ] Docs updated if conventions or contracts changed
- [ ] (schema changes) Reviewed by schema-reviewer subagent
- [ ] (new orchestration) Smoke run linked
```

4. If schema changed, invoke the `schema-reviewer` subagent on the migration files and append its verdict to the PR.
5. Print the description for the user to review. Do not push or open the PR; that's the user's job.
