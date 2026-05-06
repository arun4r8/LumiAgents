---
description: Scaffold a new orchestration end-to-end via the add-orchestration skill
---

You are scaffolding a new orchestration. Follow the `add-orchestration` skill exactly.

Arguments: $ARGUMENTS (the orchestration name, optionally followed by a one-line description)

Steps:
1. Confirm the spec with the user (input/output, triggers, access, tools, decision points). Don't skip this.
2. Run the `add-orchestration` skill.
3. After scaffolding, run `pnpm test --filter orchestrations/<name>` and report results.
4. Print a checklist of what's still required from the user before this can ship (smoke test, dashboard verification, eval cases for any LLM steps).
