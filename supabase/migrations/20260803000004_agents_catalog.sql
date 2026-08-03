-- Tier 1 agent builder (#67): the agents catalog. This is the table that lets a genuinely
-- NEW agent exist as pure DATA — a new slug, card, persona, model, tool set and knowledge
-- scope — with no dedicated Cloudflare Worker and no codegen. Such "config" agents run
-- through the runtime's existing inline runAgentChat path (the same fallback code agents
-- degrade to). The six hand-built code agents are also seeded here as source='code' rows so
-- the dashboard can render EVERY card from one catalog; those keep running via their Workers
-- (the `source` column is what distinguishes them at routing time).
--
-- RLS mirrors orchestration.agent_config_overrides / agent_configs: ops-only for
-- authenticated callers (public.is_ops()); service_role (the runtime) bypasses RLS and reads
-- the catalog on the chat path.
--
-- Rollback:
--   DROP TABLE orchestration.agent_tools;
--   DROP TABLE orchestration.agents;

-- ── Agents catalog ────────────────────────────────────────────────────────────

CREATE TABLE orchestration.agents (
  slug              text        PRIMARY KEY,
  display_name      text        NOT NULL,
  card              jsonb,                                   -- {emoji, category, description, suggestedPrompts?}
  owner             uuid        REFERENCES auth.users(id),
  source            text        NOT NULL DEFAULT 'config'
                      CHECK (source IN ('config', 'code')),
  lifecycle         text        NOT NULL DEFAULT 'active'
                      CHECK (lifecycle IN ('active', 'disabled')),
  knowledge_corpora jsonb,                                   -- bounded ⊆ [shared, <slug>, enduser]; never restricted
  created_by        uuid        REFERENCES auth.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── Agent → orchestration tool wiring ─────────────────────────────────────────
-- Each row is one tool on a config agent, wiring it to an existing orchestration. `params`
-- is merged into the tool input at dispatch (the data equivalent of a ToolMapping.transform);
-- `mode` mirrors ToolMapping.mode ('sync' only for provably read-only orchestrations).

CREATE TABLE orchestration.agent_tools (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_slug         text        NOT NULL REFERENCES orchestration.agents(slug) ON DELETE CASCADE,
  orchestration_name text        NOT NULL,
  params             jsonb,
  mode               text        NOT NULL DEFAULT 'async'
                       CHECK (mode IN ('async', 'sync')),
  position           int,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_slug, orchestration_name)
);

CREATE INDEX agent_tools_agent_slug_idx ON orchestration.agent_tools (agent_slug, position);

-- ── RLS: ops-only writes; service_role (runtime) bypasses ─────────────────────

ALTER TABLE orchestration.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration.agent_tools ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON orchestration.agents
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

CREATE POLICY "ops_all" ON orchestration.agent_tools
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

GRANT ALL ON orchestration.agents TO service_role;
GRANT ALL ON orchestration.agent_tools TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.agents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.agent_tools TO authenticated;

-- ── Seed the six code agents (source='code') ──────────────────────────────────
-- slug + display_name + card only. Their persona / tools / Worker stay in code; these rows
-- exist so the dashboard renders all cards uniformly from the catalog. knowledge_corpora is
-- left NULL for code agents (their scope is enforced in code via scopeForAgent(<slug>)).

INSERT INTO orchestration.agents (slug, display_name, source, card) VALUES
  ('angie', 'Angie', 'code', jsonb_build_object(
     'emoji', '🧑‍💼', 'category', 'HR & Recruiting',
     'description', 'Screens resumes, sources candidates, and runs the hiring pipeline.',
     'suggestedPrompts', jsonb_build_array(
       'Screen this resume for a cleared IT PM role',
       'Find 5 senior Java developers in DC',
       'Format this resume to our template'))),
  ('beady', 'Beady', 'code', jsonb_build_object(
     'emoji', '🔭', 'category', 'GovCon Intel',
     'description', 'Assesses opportunities, searches SAM.gov, and runs go/no go calls.',
     'suggestedPrompts', jsonb_build_array(
       'Assess this opportunity for go/no-go',
       'Find SBIR opportunities closing this month',
       'What''s our win probability on this RFP?'))),
  ('patch', 'Patch', 'code', jsonb_build_object(
     'emoji', '🔧', 'category', 'IT & Ops',
     'description', 'Handles Jira tickets, staff requests, doc Q&A, and ops triage.',
     'suggestedPrompts', jsonb_build_array(
       'Create a ticket for the VPN issue affecting the BD team',
       'Search for open critical tickets',
       'Request a new hire for the CISA contract'))),
  ('money', 'Money', 'code', jsonb_build_object(
     'emoji', '💰', 'category', 'Finance',
     'description', 'Builds financial reports, budget analysis, and contract burn rates.',
     'suggestedPrompts', jsonb_build_array(
       'Summarize revenue by contract for Q1 2025',
       'Which contracts are burning over budget?',
       'Show me indirect rate trends'))),
  ('cleo', 'Cleo', 'code', jsonb_build_object(
     'emoji', '🏆', 'category', 'Eminence',
     'description', 'Researches awards, runs recognition programs, and tracks eminence.',
     'suggestedPrompts', jsonb_build_array(
       'What awards should Lumiture apply for this quarter?',
       'Run a fresh award sweep',
       'Which open government small business awards are high-prestige?'))),
  ('dewey', 'Dewey', 'code', jsonb_build_object(
     'emoji', '📚', 'category', 'Knowledge',
     'description', 'Curates the knowledge base with cited answers and sensitivity tags.',
     'suggestedPrompts', jsonb_build_array(
       'What do we know about our past performance on cloud migrations?',
       'Give me an inventory of the knowledge base',
       'Lock the FY25 financial model to restricted')))
ON CONFLICT (slug) DO NOTHING;
