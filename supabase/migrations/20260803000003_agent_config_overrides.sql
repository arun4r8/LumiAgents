-- Tier 0 agent customization (#67): per-agent, append-only, versioned overrides for an
-- agent's persona (system prompt), card metadata, and enabled-tool subset. The ACTIVE
-- override is the most-recent row per agent_id; edits and reverts append a new row rather
-- than mutating history, so every prior state stays revertible.
--
-- model / max_tokens are NOT duplicated here — Tier 0 reuses orchestration.agent_configs
-- (20260514000007_agent_configs.sql) for those, now that the chat loop reads it too.
--
-- The runtime reads the latest row via service_role (bypasses RLS); the dashboard writes
-- as ops (ops_all policy, mirroring agent_configs).
--
-- Rollback:
--   DROP TABLE orchestration.agent_config_overrides;

CREATE TABLE orchestration.agent_config_overrides (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text        NOT NULL,                       -- the agent slug
  system_prompt   text,                                       -- null = no persona override
  prompt_strategy text        NOT NULL DEFAULT 'append'
                    CHECK (prompt_strategy IN ('append', 'replace')),
  card            jsonb,                                       -- optional card metadata override
  enabled_tools   jsonb,                                      -- null/[] = all of the agent's tools
  updated_by      uuid        REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Latest-row-per-agent lookup: the runtime fetches the newest override for an agent on
-- every chat turn, and the history view lists them newest-first.
CREATE INDEX agent_config_overrides_agent_created_idx
  ON orchestration.agent_config_overrides (agent_id, created_at DESC);

ALTER TABLE orchestration.agent_config_overrides ENABLE ROW LEVEL SECURITY;

-- Mirrors orchestration.agent_configs: ops-only for authenticated callers; service_role
-- (the runtime) bypasses RLS.
CREATE POLICY "ops_all" ON orchestration.agent_config_overrides
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

GRANT ALL ON orchestration.agent_config_overrides TO service_role;
GRANT SELECT, INSERT, UPDATE ON orchestration.agent_config_overrides TO authenticated;
