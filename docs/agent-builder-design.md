# In-app agent/tool builder — architecture & plug-in contract

> Design pass for [#67](https://github.com/LumitureLabs/LumiAgents/issues/67). Status: proposal, no runtime code changed. Read alongside `docs/auth-model.md`, `docs/workflow-contract.md`, and `docs/databricks-assessment.md` §4 (the plug-in contract v0.1 this doc makes concrete).

## 0. What #67 asks for

A self-serve, in-app flow so non-technical users can (a) **extend/customize existing agents** — Travis's example: make Cleo draft **Instagram** content instead of LinkedIn — and (b) **create new agents/tools**, mapping the process today done by hand with Claude Code: a dedicated Cloudflare Worker + MCP-style tools + markdown/code in GitHub + CF secrets + Supabase tables.

Per the framework note on the issue, the builder is a **codegen/templating layer over our existing Worker + orchestration pattern**, not a LangChain/LangGraph bolt-on. It must emit *our* artifacts (Worker + `defineOrchestration` definitions + agent tool maps + Supabase rows + secrets) so the dashboard, runs, approvals, and RAG scoping all understand a builder-made agent exactly as they understand the hand-built six. And it must support an **edit round-trip**, not only create.

The whole design turns on one question answered in §1: **which parts of "an agent" are data today, and which are code?** That split decides what is self-serve now versus what needs a code-gen + review + deploy pipeline.

---

## 1. Current-state map — what it takes to add/customize an agent today

### 1.1 How an agent exists end-to-end

An agent today is **not a database row**. Per `docs/auth-model.md`, agents have no DB identity; they run inside the runtime as Supabase `service_role`. An "agent" is assembled from artifacts spread across four layers:

| # | Artifact | File / table | Layer | Config or code? |
|---|----------|--------------|-------|-----------------|
| 1 | Agent definition: `slug`, `displayName`, `systemPrompt`, `tools`, `toolMap` | `agents/<slug>/index.ts` (shape in `agents/types.ts`) | Code, bundled into runtime | **Code + deploy** |
| 2 | Registry entry | `agents/index.ts:11` (`AGENTS` record) | Code | **Code + deploy** |
| 3 | Slug in the narrowing union | `runtime/src/agents/agent-chat.ts:40` (`AgentSlug`) | Code | **Code + deploy** |
| 4 | Service-binding wiring | `runtime/src/routes/agents.ts:27` (`AGENT_BINDINGS`) + the `*_WORKER` field in `runtime/src/types/index.ts` (`Env`) | Code | **Code + deploy** |
| 5 | The agent's own Worker | `runtime/src/workers/<slug>.ts` (one line: `makeAgentWorker("<slug>")`, factory in `runtime/src/workers/agent-worker.ts`) + `runtime/workers/<slug>/wrangler.toml` | Code + CF Worker | **Code + deploy + `wrangler deploy`** |
| 6 | Dashboard card metadata: emoji, category, description, suggested prompts | `dashboard/app/(dashboard)/agents/page.tsx:16` (a **second** `AGENTS` array, unrelated to the runtime one) | Code, bundled into dashboard | **Code + deploy** |
| 7 | Each capability = an orchestration | `orchestrations/<slug>/<name>/definition.ts` (`defineOrchestration`, `runtime/src/index.ts:14`) | Code | **Code + deploy** |
| 8 | Orchestration registry | `runtime/src/registry.ts` (hardcoded imports + a `Map`) | Code | **Code + deploy** |
| 9 | Orchestration catalog rows | `orchestration.orchestrations` table, seeded by migration (`supabase/migrations/20260513000001_seed_orchestrations.sql`, `20260709000003_register_dewey.sql`) | Data, but authored as a migration | **Migration + deploy** |
| 10 | Per-agent LLM config | `orchestration.agent_configs` (`agent_id`, `model`, `max_tokens`, `notes`) — `supabase/migrations/20260514000007_agent_configs.sql` | **Data** | Config (editable in Settings) |
| 11 | Domain tables the agent writes | e.g. `content_calendar`, `opportunities` — a migration + RLS | Data, via migration | **Migration + deploy** |
| 12 | Secrets | `wrangler secret put --name lumiagents-<slug>` (e.g. `ANTHROPIC_API_KEY`) | CF secret store | **Ops action** |

At **runtime**, a chat request flows: dashboard → `POST /api/agents/:slug/chat` (`runtime/src/routes/agents.ts`) → mint a short-lived `agent-dispatch` JWT → forward over the Service Binding to `lumiagents-<slug>` → `makeAgentWorker` → `runAgentChat` (`runtime/src/agents/agent-chat.ts`). The chat loop reads `agent.systemPrompt` and `agent.tools` **straight from the bundled `AGENTS` object** (`agent-chat.ts:246-247`), calls Claude, and for each tool-use dispatches `toolMap[tool].orchestration` back to `/api/orchestrations/:name/run` (async) or `/run-sync` (read-only). If the Worker is unreachable, the runtime degrades to the same `runAgentChat` inline.

### 1.2 The critical wiring gaps (these shape the first slice)

Two facts decide how much is self-serve *today*:

1. **The chat loop hardcodes the model and ignores `agent_configs`.** `runtime/src/agents/agent-chat.ts:6` is `const MODEL = "claude-sonnet-4-6"`, used at `:244` with `max_tokens: 2048` at `:245`. `agent_configs.model` / `.max_tokens` are read **only** on the orchestration path (`runtime/src/utils/resolve-model.ts` → `resolveOrchestrationModel`, used in `workflow.ts` / `run-inline.ts`). So the Settings "model per agent" control (`dashboard/app/(dashboard)/settings/`) already steers what an agent's *orchestrations* use, but **not the agent's chat persona model**. Wiring the chat loop to read `agent_configs` is a small, high-value change and a prerequisite for Tier 0.

2. **The system prompt lives only in code.** `agent_configs` has `model`, `max_tokens`, `notes` — **no prompt column**. Cleo's persona, including the LinkedIn-specific language ("drafting the eminence content calendar (**LinkedIn** posts)", `agents/cleo/index.ts`), is a code constant. Travis's "Instagram instead of LinkedIn" ask is therefore a **code + deploy** today. Making it data means adding a prompt/overrides store and having the chat loop layer it on.

### 1.3 Config-vs-code summary

**Already pure data — changeable with no code deploy** (mostly via `dashboard/app/(dashboard)/settings/`, `updateAgentConfig` / `updateOrchestrationConfig` in `settings/actions.ts`):

- `agent_configs.model` / `max_tokens` / `notes` per agent (steers orchestration runs today; *not yet* the chat loop — see gap #1).
- Per-orchestration `model`, `notes`, `cron`, `description`, `is_active` on `orchestration.orchestrations`.
- Schedules (`orchestration_schedules`) and orchestration access/visibility (`orchestration_access`; currently endusers can see any active orchestration — `supabase/migrations/20260803000001_...`).

**Requires new code + deploy today:**

- Agent **system prompt / persona** (item 1 — the Instagram case).
- The agent's **tool list and `toolMap`** (which orchestrations it can call, and their channel/behavior).
- Whether a capability (**orchestration**) exists at all (items 7–9).
- Agent **identity/registration** (items 1–6): registry, slug union, bindings, Worker, dashboard card.
- New **domain tables** + RLS (item 11).

**The crux:** the parts a non-technical user most wants to change — *persona, channel, which tools are on* — are exactly the parts that are code today. The builder's job is to move the **first tier of those into data** (Tier 0), then codegen the rest behind a review gate (Tiers 1–2). Travis's Instagram example sits precisely on the persona/channel boundary and is the natural first target.

---

## 2. The agent manifest / plug-in contract

We adopt the plug-in contract sketched in `docs/databricks-assessment.md` §4 (manifest v0.1) as the **single declarative description of an agent**, and bind each block to a real LumiAgents structure. The manifest is the artifact the builder reads and writes for **both** create and edit; §1's four layers are its compile targets.

Scoping note vs. the Databricks v0.1 draft: that spec includes an `eval:` block bound to a Mosaic eval spine. We have **no eval harness today** (roadmap parks it out of scope; `docs/databricks-assessment.md` §1.1). So `eval:` is **declared-but-optional** in the builder's contract for now — validated for shape, not enforced as a gate — and becomes a hard admission gate only if/when the eval spine lands. Everything else maps to something that exists.

### 2.1 Schema (builder contract v0.1, LumiAgents-native binding)

```yaml
apiVersion: lumiagents/v0.1
kind: Agent

# 1. IDENTITY  →  agents/<slug>/index.ts (slug, displayName) + dashboard AGENTS card
identity:
  slug: cleo-instagram          # kebab-case, globally unique; the routing key
  displayName: Cleo (Instagram) # human handle
  owner: arun.rajendra8@gmail.com
  lifecycle: proposed           # proposed | active | deprecated
  card:                         # → dashboard/app/(dashboard)/agents/page.tsx AgentMeta
    emoji: "📸"
    category: Eminence
    description: Drafts Instagram eminence content instead of LinkedIn.
    suggestedPrompts:
      - Draft an Instagram caption for this week's award win
      - Plan a month of Instagram posts around our SBIR portfolio

# 2. DERIVATION  →  how this agent relates to an existing one (edit round-trip)
derivedFrom: cleo               # null for a from-scratch agent; a slug for a variant
mode: config-only               # config-only (Tier 0/1) | codegen (Tier 2)

# 3. PERSONA  →  system prompt (NEW: agent_config_overrides.system_prompt)
persona:
  systemPrompt: |
    You are Cleo, Lumiture's eminence and content assistant, drafting for INSTAGRAM.
    Optimize for visual-first captions: a strong hook line, 3-6 short lines, 3-8
    relevant hashtags, one clear CTA. Never write LinkedIn-style long-form posts.
    A human always reviews before posting. Do not use em dashes.
  promptStrategy: replace       # replace | append (append = base prompt + this)

# 4. MODEL  →  orchestration.agent_configs (model, max_tokens)
model:
  id: claude-sonnet-4-6         # must be a value in runtime/src/config/models.ts MODELS
  maxTokens: 2048

# 5. TOOLS  →  agents/<slug>/index.ts tools[] + toolMap
tools:
  enabled:                      # each references an orchestration in the registry
    - tool: plan_calendar
      orchestration: cleo/content-plan
    - tool: draft_content
      orchestration: cleo/content-draft
      params: { channel: instagram }   # passed via ToolMapping.transform
    - tool: get_recent_content
      orchestration: cleo/recent-content
      mode: sync                # sync = read-only, awaited; async = fire-and-forget
  # 'new' tools (needing a new orchestration) force mode: codegen → Tier 2 review gate
  new: []

# 6. KNOWLEDGE  →  runtime/src/agents/knowledge-access.ts scopeForAgent()
knowledge:
  corpora: [shared, cleo]       # agent always gets [shared, <ownCorpus>]
  includeRestricted: false      # restricted is ops-only; never true for an agent

# 7. TRIGGERS / SCHEDULE  →  orchestration.orchestrations.cron + orchestration_schedules
triggers:
  channel: chat                 # chat | scheduled | event
  schedules: []

# 8. SECRETS  →  wrangler secret put (NEVER inlined; names only, values via ops)
secrets:
  required: [ANTHROPIC_API_KEY] # inherited from the shared agent-worker template

# 9. EVAL  →  declared-but-optional until the eval spine exists (databricks §4)
eval:
  suiteRef: null
```

### 2.2 How each block maps onto today's structures

| Manifest block | Compiles to | Config or codegen |
|---|---|---|
| `identity.slug`, `displayName` | `agents/<slug>/index.ts`; a new **`agents` catalog table** row (see §4) | Tier 0/1: data row · Tier 2: also code |
| `identity.card` | dashboard `AGENTS` metadata — moved from `page.tsx` into the same catalog table so cards render from data | Data |
| `persona.systemPrompt` | **new** `orchestration.agent_config_overrides` (or a `system_prompt` column on a per-agent config table); chat loop layers it in | Data (once wired) |
| `model` | `orchestration.agent_configs.model` / `max_tokens` (already exists) | Data |
| `tools.enabled` | `agents/<slug>.toolMap` — as data, an `agent_tools` join (agent → orchestration + params + mode) the chat loop reads | Data if all orchestrations exist |
| `tools.new` | a new `orchestrations/<slug>/<name>/definition.ts` + registry entry | **Codegen (Tier 2)** |
| `knowledge.corpora` | `scopeForAgent()` result; today derived from slug — make it read the manifest's declared corpora (still bounded: never `restricted`, never another agent's private corpus) | Data (bounded) |
| `triggers.schedules` | `orchestration_schedules` rows | Data |
| `secrets` | `wrangler secret put` — names validated, values supplied out-of-band by ops | Ops action |

The manifest is stored canonically as a row (JSONB) in the new `agents` catalog table and, for Tier 2 agents, **also** written to the repo as `agent.manifest.yaml` next to the generated Worker so GitHub remains the source of truth for code-bearing agents (aligns with `docs/databricks-assessment.md` §4: "one file, lives in the agent's Worker repo").

### 2.3 Worked example — the "Instagram Cleo" variant

The YAML in §2.1 **is** the filled example (`slug: cleo-instagram`, `derivedFrom: cleo`, `mode: config-only`). It is a pure **Tier 0/1** artifact: every orchestration it references (`cleo/content-plan`, `cleo/content-draft`, `cleo/recent-content`) already exists in `runtime/src/registry.ts`; the only differences from Cleo are the **system prompt** (Instagram framing), the `draft_content` **channel param**, and the **card metadata**. No new code, no new orchestration, no Worker — provided the two wiring gaps in §1.2 are closed (chat loop reads `agent_configs`; a prompt-override store exists). This is the smallest possible thing that satisfies Travis's ask, and it defines the first slice (§5).

To make it *fully* channel-correct, `cleo/content-draft` would grow a `channel` input (LinkedIn default) so the same orchestration drafts either format — a **one-orchestration code change** that can ship in the same first slice, keeping the agent itself config-only.

---

## 3. Builder flows

### 3.1 Create flow

1. **Start** — user picks "New agent" and either "from scratch" or "start from an existing agent" (pre-fills `derivedFrom`).
2. **Compose** — form-driven editing of the manifest: identity + card, persona (prompt editor with the base prompt shown when `promptStrategy: append`), model (dropdown bounded to `MODELS`), tool toggles (checkboxes over the orchestration catalog from `GET /api/orchestrations`), knowledge corpora, schedule.
3. **Validate** — the manifest is checked against the contract (§3.3) live; blocking errors disable Save.
4. **Preview** — a sandboxed chat against the *draft* manifest (persona + enabled tools) with tool dispatch in **dry-run** (tools resolve but async orchestrations are not actually fired, or are fired against a preview flag). Lets the user feel the persona before deploying.
5. **Deploy** — meaning depends on tier (§4). Tier 0/1: write the catalog + config rows, agent goes live immediately (runtime reads config). Tier 2: generate code + open a PR; agent is `proposed` until merged.

### 3.2 Edit round-trip (the #67 scope note)

1. **Load** — read the agent's manifest. For a config-only agent, reconstruct it from the catalog + `agent_configs` + `agent_tools` rows. For a code-bearing (Tier 2) agent, read `agent.manifest.yaml` from its repo path.
2. **Edit** — same composer as create, pre-filled.
3. **Re-validate** — re-run §3.3 against the edited manifest, including **diff-aware** checks: a change that stays within data (prompt, model, tool toggles) keeps the agent config-only; a change that adds a `tools.new` entry or a new domain table **escalates the agent to Tier 2** and forces the review gate. The UI must show this escalation explicitly ("this change now requires an engineering review").
4. **Redeploy** — config-only edits write new rows and take effect on the next chat turn (the loop reads config per request). Tier 2 edits bump the manifest version and open a PR.

Editing one of the **original six** hand-built agents is a special case: their persona/tools live in code (`agents/cleo/index.ts`), not in the catalog. The migration path (§5, Phase 1) seeds a catalog row + `agent_configs` override slot for each of the six so the chat loop prefers the override when present and falls back to the code constant when absent. That makes the six editable at Tier 0 **without** rewriting them, and keeps code as the safety net.

### 3.3 Validation (all tiers)

- **Identity** — `slug` unique across the catalog and not colliding with a code agent; `owner` is a real user.
- **Model** — `model.id ∈ MODELS` (`runtime/src/config/models.ts`); `maxTokens` within bounds.
- **Tools** — every `tools.enabled[].orchestration` exists in the registry catalog and is `is_active`; `mode: sync` only on orchestrations that are provably read-only (no `await_approval`, no mutation — the rule already documented on `ToolMapping` in `agents/types.ts` and in `run-inline.ts`); any `tools.new` entry flips the manifest to `mode: codegen`.
- **Knowledge** — `corpora ⊆ [shared, <ownSlug>, enduser]`; `includeRestricted` must be `false` for any non-ops agent (enforced in `knowledge-access.ts`, mirrored here at author time).
- **Persona** — non-empty; length cap; injection-guard note preserved (the loop always appends `INJECTION_GUARD`, `agent-chat.ts`).
- **Secrets** — names only; no values in the manifest (CLAUDE.md: "No secrets in code").
- **Prompt-injection posture** — the persona is authored by an ops/enduser, but the builder must treat any *tool output / uploaded content* the preview surfaces as untrusted, consistent with the runtime's existing guard.

Validation is transactional: all blocks pass or Save/Deploy is refused with a per-block reason list (same posture as `docs/databricks-assessment.md` §4.3).

---

## 4. Deploy tiers + recommendation

Three tiers, increasing power and risk. The dividing line is **does deploying this require running generated code in production?**

### Tier 0 — config-only customization of an existing agent (NO code deploy)

Change persona, model, `max_tokens`, enabled-tools (from the agent's existing tool set), channel params, and card metadata on an agent that already exists. Backed entirely by data the runtime reads at request time:

- `orchestration.agent_configs` (model / max_tokens — already there).
- **new** per-agent prompt/overrides store (persona, card, enabled-tool toggles).
- The chat loop wired to read both (closes §1.2 gaps).

**Deploy = write rows.** Effective on the next chat turn. No PR, no Worker, no migration. **This covers Travis's Instagram example** and is the recommended **first slice**.

Risk: low. Blast radius is one agent's prompt/model/tool-toggles; nothing new executes. A bad prompt is a bad *output*, not a security event, and is instantly revertible (versioned rows).

### Tier 1 — new config-only agent, assembled from existing tools/orchestrations

A genuinely new agent (new slug, new card, its own persona) that **only** wires together orchestrations that already exist in the registry. Backed by a **new `agents` catalog table** so an agent can exist as data:

- `agents` catalog row (slug, displayName, card, owner, lifecycle, `source: 'config'`).
- `agent_tools` rows (agent → orchestration + params + mode).
- `agent_configs` + overrides as Tier 0.
- Runtime made **catalog-aware**: `AGENTS` becomes "code agents ∪ catalog agents"; `AgentSlug`/`AGENT_BINDINGS` stop being the gate for config agents (they route through the runtime's inline `runAgentChat`, which is already the fallback path — a config agent simply has no dedicated Worker and always runs inline). This is the one non-trivial runtime change Tier 1 needs, and it reuses the existing degraded-mode path rather than inventing a new one.

**Deploy = write rows.** No dedicated Worker (runs inline), no new orchestration, no migration per agent. Risk: low–moderate (a new agent surface, but only reusing vetted tools).

### Tier 2 — full new-code agent/tool (manifest → codegen → GitHub PR → CI → deploy)

Anything that needs **new** behavior: a new orchestration/tool, a new integration, a new domain table, or a dedicated Worker. The builder generates the artifacts — `orchestrations/<slug>/<name>/definition.ts` (from the `add-orchestration` skill's template, `.claude/skills/add-orchestration/SKILL.md`), registry entry, `agents/<slug>/index.ts`, wrangler config, seed migration — writes `agent.manifest.yaml`, and **opens a PR**.

**Deploy = a human reviews and merges; CI deploys.** This is mandatory and non-negotiable:

> **Governance gate.** Non-technical users must never push generated code straight to production. Every Tier 2 change lands as a **PR that an ops engineer reviews and merges** (the `ops` role, `docs/auth-model.md`; the 4 provisioned ops users are the approvers). CI runs typecheck/lint/tests and, when the eval spine exists (`databricks-assessment.md` §4), the agent's eval gate, before the Worker deploys. The builder can *draft* code; only a human merges it. Migrations remain forward-only and reviewed (CLAUDE.md).

Risk: high without the gate (arbitrary code + new data access + secrets), acceptable with it.

### Recommendation & phasing

**Ship Tier 0 first.** It is the smallest change that satisfies the concrete ask on the issue (Instagram Cleo), it touches no code-deploy path, it is fully revertible, and it forces us to close the two wiring gaps (§1.2) that every later tier depends on anyway (a config-driven chat loop). **Tier 1 second** (once the `agents` catalog exists, new config agents are cheap). **Tier 2 last and gated** — it is where the real risk lives, and it should not block the value in 0/1. Defer Tier 2 until Tiers 0/1 are in real use and the review/eval gate is built.

---

## 5. Phased build plan

### Phase 1 — Tier 0 (the first PR-sized slice)

Goal: **customize an existing agent's persona + model + enabled-tools from the app, no code deploy** — deliver the Instagram Cleo case.

Touches:

- **Migration** — `agent_config_overrides` (or extend `agent_configs`): `agent_id`, `system_prompt text`, `prompt_strategy text`, `card jsonb`, `enabled_tools jsonb`, `updated_by`, `updated_at`; RLS `ops_all` mirroring `agent_configs` (`supabase/migrations/20260514000007_agent_configs.sql`). Optionally a `channel` input on `cleo/content-draft`.
- **Runtime** — wire `runAgentChat` (`runtime/src/agents/agent-chat.ts`) to resolve model/max_tokens/system_prompt from config instead of the hardcoded `MODEL`/`2048`/`agent.systemPrompt` (`:6`, `:244-246`); a `db.getAgentOverrides(slug)` on `runtime/src/db/client.ts` next to `getAgentConfig` (`:272`); prompt layered per `prompt_strategy`.
- **Dashboard** — extend Settings (`dashboard/app/(dashboard)/settings/`) or a new "Customize agent" panel on the agent page: prompt editor, model dropdown, tool toggles; a Preview chat; a `saveAgentOverrides` server action beside `updateAgentConfig` (`settings/actions.ts`).
- **Validation + versioning** — the §3.3 checks; keep prior override rows for one-click revert.

Ships one thing end-to-end: an ops/enduser makes Cleo draft Instagram content and back, from the dashboard, with no deploy.

### Phase 2 — Tier 1 (new config-only agents)

- `agents` catalog table (identity + card + `source`); runtime `AGENTS` = code ∪ catalog; config agents route through the existing inline `runAgentChat` fallback (no dedicated Worker).
- `agent_tools` join; the composer's tool picker reads the orchestration catalog (`GET /api/orchestrations`, `runtime/src/routes/orchestrations.ts`).
- Dashboard cards render from the catalog (retire the hardcoded `AGENTS` array in `dashboard/.../agents/page.tsx`).
- Full create + edit round-trip (§3) for config agents.

### Phase 3 — Tier 2 (codegen + review gate)

- Manifest → code generators driven by the `add-orchestration` skill template and the Worker scaffold (`agent-worker.ts` factory).
- GitHub PR automation (branch, commit generated files + `agent.manifest.yaml`, open PR), CI checks, ops-merge gate.
- Secrets provisioning runbook (`wrangler secret put`), never through the app.
- Align with `docs/databricks-assessment.md` §4: the generated `agent.manifest.yaml` **is** the plug-in contract artifact; when the eval spine lands, its `eval:` block becomes a hard CI admission gate. This is the #84 alignment — the builder's Tier 2 output is exactly the manifest #84 defines, so we do not reinvent it.

### #71 onboarding tie-in

The builder needs first-run guidance (Travis's "the design assumes all users know how to interact with agents"). #71's remaining scope explicitly lists "builder onboarding tied to #67." Concretely: a first-run welcome in the composer, an annotated pre-filled example (the Instagram Cleo manifest as the worked tutorial), inline explanations of persona/model/tools, and the escalation notice when an edit crosses into Tier 2. Build this alongside Phase 1 so the first self-serve surface is legible to non-technical users on day one.

---

## 6. Open decisions for the product owner

1. **Codegen vs. config — how far in v1?** Recommendation: Tiers 0/1 (config) now, Tier 2 (codegen) deferred behind the gate. Confirm we are comfortable shipping *only* customization-of-existing + assembly-from-existing first, with net-new tools/agents as a later, reviewed phase.
2. **The approval gate — who approves, and how automated?** Recommendation: ops-role human merge on every Tier 2 PR (the 4 ops users), CI-blocking, eval-gated once eval exists. Decision needed: is a single ops approver enough, or do code-bearing agents need a second reviewer / a named owner sign-off?
3. **New-code agents in scope now or deferred?** Recommendation: deferred (Phase 3). Confirm, so Phases 1–2 aren't held hostage to the codegen/review machinery.
4. **Secrets handling.** The app must never accept secret *values* (CLAUDE.md). Decision: keep Tier 2 secrets an ops-runbook step (`wrangler secret put`), or invest in a brokered flow (app captures a request, ops fulfills via Supabase Vault / CF API)? Recommendation: runbook first.
5. **Multi-tenant / enduser implications.** Endusers now exist (path built, none provisioned yet — `docs/auth-model.md`). Decisions: (a) may endusers *build/customize* agents, or only ops? (b) are custom agents global or scoped to their owner/department (the manifest has `owner`; the tenancy model in `databricks-assessment.md` §4 has `department`)? (c) knowledge scope for enduser-built agents must stay bounded to `[shared, enduser]`, never `restricted`, never another agent's private corpus (`knowledge-access.ts`). Recommendation: ops-only authoring in v1; enduser authoring is a later, tenancy-scoped decision.
6. **Do the original six become catalog-managed?** Recommendation: seed catalog + override rows for the six so they're Tier 0-editable while their code persona stays as the fallback. Decision: is a hybrid (code fallback + data override) acceptable long-term, or do we want a one-time migration of the six fully into data?
7. **Eval gate timing.** The manifest reserves `eval:` but we have no eval spine. Decision: ship Tiers 0/1 with prompt/model changes *ungated* by eval (revertible, low-risk), and require eval only for Tier 2 once the spine exists — or invest in eval earlier? Recommendation: ungated for 0/1, gated for 2-when-eval-lands.
