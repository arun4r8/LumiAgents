# Claude Code handoff package

Drop the contents of this folder into the root of your repo. Specifically:

```
your-repo/
├── CLAUDE.md            # the constitution; auto-loaded every session
├── docs/
│   ├── architecture.md
│   ├── data-model.md
│   ├── workflow-contract.md
│   └── roadmap.md
└── .claude/
    ├── skills/
    │   ├── add-orchestration/SKILL.md
    │   ├── add-integration/SKILL.md
    │   └── write-migration/SKILL.md
    ├── agents/
    │   ├── codebase-researcher.md
    │   └── schema-reviewer.md
    └── commands/
        ├── new-orchestration.md
        ├── deploy-dev.md
        └── prep-pr.md
```

## What each piece does

**`CLAUDE.md`** — Loaded into every Claude Code session in this repo. It's the constitution: the mental model, stack, conventions, and "read first" pointers. Keep it short. When you find yourself adding more than a paragraph on a specific topic, that paragraph belongs in `docs/` or in a skill instead.

**`docs/`** — The four documents Claude Code is told to read first. They contain the decisions you don't want relitigated every session: the architecture, the schema, the workflow contract, and what's in/out of scope.

**`.claude/skills/`** — Reusable playbooks. These load only when a task matches the description, so they don't burn context until needed. Three to start with — adding an orchestration, adding an integration, writing a migration. Add more as you notice yourself repeating playbooks.

**`.claude/agents/`** — Subagents Claude can delegate to in their own context window. `codebase-researcher` for "find every X" questions that would otherwise pollute main context with file reads. `schema-reviewer` for migration review. Both keep main session focused.

**`.claude/commands/`** — Slash commands for repeated workflows. `/new-orchestration <name>`, `/deploy-dev`, `/prep-pr`.

## Day-one workflow

The roadmap currently sits at **Phase 0 — Decisions and inventory**. The first session with Claude Code in the new repo should be:

1. Open Claude Code in the repo. Confirm it loaded `CLAUDE.md`.
2. Ask: "Read all the docs in /docs/ and tell me back, in your own words, what we're building and what Phase 0 needs."
3. From there, work through Phase 0 deliverables one at a time. Use plan mode (Shift+Tab) — Phase 0 is mostly thinking and writing, not coding, and plan mode keeps Claude in the right gear.
4. When Phase 0 produces the n8n inventory, integrations inventory, target orchestrations list, auth model, and Supabase audit, move to Phase 1.

## Maintenance rules

- When you find yourself correcting Claude on the same thing twice, write it down — either in `CLAUDE.md` (if it applies always) or in a skill (if it applies to a specific task).
- When `CLAUDE.md` gets longer than ~250 lines, prune. Move detail into docs or skills. The 200-line ceiling is real — past it, the model starts ignoring instructions.
- When a doc and the code disagree, the code is right. Update the doc the same hour.
- Skills should describe what's non-obvious. If Claude already does the right thing without the instruction, delete the instruction.

## What you'll add over time

Things this package deliberately doesn't include yet, because they depend on choices you haven't made:

- Hooks (`.claude/hooks/`). Add when you have deterministic enforcement needs — e.g., block deploys without a passing test run, run a secret scanner on every edit. Premature without a real workflow yet.
- Eval skill / agent for the LLM decision points. Add in Phase 2 when the first orchestration with `llm_decide` ships.
- A "mock-n8n" fixture skill for tests. Add when you've written the first integration test and feel the friction.
- A dashboard-component skill capturing your shadcn patterns. Add when you've built the second dashboard page and noticed the repetition.

The pattern: don't anticipate. Add when the friction is real.
