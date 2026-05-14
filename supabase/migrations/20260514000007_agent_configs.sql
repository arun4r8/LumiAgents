-- Per-agent LLM configuration and orchestration-level overrides.
-- Lets ops teams change models, prompts, and notes from the dashboard
-- without touching Workers code or redeploying.

-- ── Agent configs ─────────────────────────────────────────────────────────────

CREATE TABLE orchestration.agent_configs (
  agent_id   text PRIMARY KEY,
  model      text NOT NULL DEFAULT 'claude-sonnet-4-6',
  max_tokens integer NOT NULL DEFAULT 4096,
  notes      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

INSERT INTO orchestration.agent_configs (agent_id, model) VALUES
  ('angie', 'claude-sonnet-4-6'),
  ('beady', 'claude-sonnet-4-6'),
  ('money', 'claude-sonnet-4-6'),
  ('patch', 'claude-sonnet-4-6')
ON CONFLICT (agent_id) DO NOTHING;

ALTER TABLE orchestration.agent_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON orchestration.agent_configs
  FOR ALL TO authenticated
  USING (public.is_ops())
  WITH CHECK (public.is_ops());

GRANT ALL ON orchestration.agent_configs TO service_role;
GRANT SELECT, INSERT, UPDATE ON orchestration.agent_configs TO authenticated;

-- ── Orchestration-level overrides ─────────────────────────────────────────────

ALTER TABLE orchestration.orchestrations
  ADD COLUMN IF NOT EXISTS model text,   -- null = inherit from agent_configs
  ADD COLUMN IF NOT EXISTS notes text;   -- internal ops notes
