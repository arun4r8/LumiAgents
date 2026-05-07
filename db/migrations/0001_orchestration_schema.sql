-- Migration 0001: Create orchestration schema and core tables
-- Rollback: DROP SCHEMA orchestration CASCADE;

CREATE SCHEMA IF NOT EXISTS orchestration;

-- Grant usage to authenticated and service roles
GRANT USAGE ON SCHEMA orchestration TO authenticated, service_role;

-- ─────────────────────────────────────────────
-- orchestrations: workflow definitions (versioned)
-- ─────────────────────────────────────────────
CREATE TABLE orchestration.orchestrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  version          integer NOT NULL DEFAULT 1,
  description      text,
  input_schema     jsonb NOT NULL DEFAULT '{}',
  output_schema    jsonb NOT NULL DEFAULT '{}',
  is_active        boolean NOT NULL DEFAULT false,
  cron             text,                    -- cron expression if scheduled
  definition_hash  text,                   -- sha256 of definition.ts for drift detection
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

ALTER TABLE orchestration.orchestrations ENABLE ROW LEVEL SECURITY;

-- Ops can do everything
CREATE POLICY "ops_all" ON orchestration.orchestrations
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role') = 'ops')
  WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

-- End users can read active orchestrations they have access to
CREATE POLICY "enduser_read_active" ON orchestration.orchestrations
  FOR SELECT TO authenticated
  USING (
    is_active = true
    AND (auth.jwt() ->> 'role') = 'enduser'
    AND EXISTS (
      SELECT 1 FROM orchestration.orchestration_access oa
      WHERE oa.orchestration_id = id
        AND oa.user_id = auth.uid()
    )
  );

-- Service role bypasses RLS (intentional — runtime is trusted)
GRANT ALL ON orchestration.orchestrations TO service_role;
GRANT SELECT ON orchestration.orchestrations TO authenticated;

-- ─────────────────────────────────────────────
-- orchestration_access: which users can trigger which orchestrations
-- ─────────────────────────────────────────────
CREATE TABLE orchestration.orchestration_access (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  orchestration_id   uuid NOT NULL REFERENCES orchestration.orchestrations(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL,        -- references auth.users(id)
  can_trigger        boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orchestration.orchestration_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON orchestration.orchestration_access
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role') = 'ops')
  WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

CREATE POLICY "enduser_read_own" ON orchestration.orchestration_access
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

GRANT ALL ON orchestration.orchestration_access TO service_role;
GRANT SELECT ON orchestration.orchestration_access TO authenticated;

-- ─────────────────────────────────────────────
-- runs: one row per orchestration invocation
-- ─────────────────────────────────────────────
CREATE TYPE orchestration.run_status AS ENUM (
  'pending', 'running', 'paused', 'completed', 'failed', 'cancelled'
);

CREATE TYPE orchestration.trigger_source AS ENUM (
  'user', 'cron', 'webhook', 'orchestration'
);

CREATE TABLE orchestration.runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  orchestration_id         uuid NOT NULL REFERENCES orchestration.orchestrations(id),
  orchestration_version    integer NOT NULL,
  status                   orchestration.run_status NOT NULL DEFAULT 'pending',
  input                    jsonb NOT NULL DEFAULT '{}',
  output                   jsonb,
  error                    jsonb,
  triggered_by             orchestration.trigger_source NOT NULL,
  triggered_by_user_id     uuid,           -- auth.users(id) if triggered_by = 'user'
  triggered_by_run_id      uuid REFERENCES orchestration.runs(id),  -- if child run
  started_at               timestamptz,
  ended_at                 timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX runs_orchestration_id_idx ON orchestration.runs(orchestration_id);
CREATE INDEX runs_status_idx ON orchestration.runs(status);
CREATE INDEX runs_triggered_by_user_id_idx ON orchestration.runs(triggered_by_user_id);
CREATE INDEX runs_created_at_idx ON orchestration.runs(created_at DESC);

ALTER TABLE orchestration.runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON orchestration.runs
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role') = 'ops')
  WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

-- End users see their own runs plus runs they're assigned for approval
CREATE POLICY "enduser_read_own_or_approval" ON orchestration.runs
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() ->> 'role') = 'enduser'
    AND (
      triggered_by_user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM orchestration.approvals a
        WHERE a.run_id = id
          AND a.requested_from_user_id = auth.uid()
      )
    )
  );

GRANT ALL ON orchestration.runs TO service_role;
GRANT SELECT ON orchestration.runs TO authenticated;

-- ─────────────────────────────────────────────
-- run_steps: per-step execution log
-- ─────────────────────────────────────────────
CREATE TYPE orchestration.step_type AS ENUM (
  'step', 'llm_decide', 'llm_extract', 'await_approval', 'invoke'
);

CREATE TYPE orchestration.step_status AS ENUM (
  'running', 'completed', 'failed', 'skipped'
);

CREATE TABLE orchestration.run_steps (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               uuid NOT NULL REFERENCES orchestration.runs(id) ON DELETE CASCADE,
  step_index           integer NOT NULL,
  step_name            text NOT NULL,
  step_type            orchestration.step_type NOT NULL,
  status               orchestration.step_status NOT NULL DEFAULT 'running',
  input                jsonb,
  output               jsonb,
  error                jsonb,
  llm_model            text,
  llm_prompt           text,              -- full prompt logged for observability
  llm_response         text,             -- full response
  llm_input_tokens     integer,
  llm_output_tokens    integer,
  started_at           timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz
);

CREATE INDEX run_steps_run_id_idx ON orchestration.run_steps(run_id);
CREATE INDEX run_steps_step_type_status_idx ON orchestration.run_steps(step_type, status);

ALTER TABLE orchestration.run_steps ENABLE ROW LEVEL SECURITY;

-- Inherits visibility from parent run
CREATE POLICY "ops_all" ON orchestration.run_steps
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role') = 'ops')
  WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

CREATE POLICY "enduser_read_if_run_visible" ON orchestration.run_steps
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() ->> 'role') = 'enduser'
    AND EXISTS (
      SELECT 1 FROM orchestration.runs r
      WHERE r.id = run_id
        AND (
          r.triggered_by_user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM orchestration.approvals a
            WHERE a.run_id = r.id AND a.requested_from_user_id = auth.uid()
          )
        )
    )
  );

GRANT ALL ON orchestration.run_steps TO service_role;
GRANT SELECT ON orchestration.run_steps TO authenticated;

-- ─────────────────────────────────────────────
-- tool_calls: per call to n8n / integrations
-- ─────────────────────────────────────────────
CREATE TYPE orchestration.tool_call_status AS ENUM (
  'pending', 'success', 'failed', 'retrying'
);

CREATE TABLE orchestration.tool_calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_step_id       uuid NOT NULL REFERENCES orchestration.run_steps(id) ON DELETE CASCADE,
  tool_name         text NOT NULL,
  idempotency_key   text,
  request           jsonb,
  response          jsonb,
  status            orchestration.tool_call_status NOT NULL DEFAULT 'pending',
  status_code       integer,
  latency_ms        integer,
  attempt           integer NOT NULL DEFAULT 1,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);

CREATE INDEX tool_calls_run_step_id_idx ON orchestration.tool_calls(run_step_id);
CREATE INDEX tool_calls_tool_name_idx ON orchestration.tool_calls(tool_name);
CREATE UNIQUE INDEX tool_calls_idempotency_key_idx ON orchestration.tool_calls(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE orchestration.tool_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON orchestration.tool_calls
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role') = 'ops')
  WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

CREATE POLICY "enduser_read_if_run_visible" ON orchestration.tool_calls
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() ->> 'role') = 'enduser'
    AND EXISTS (
      SELECT 1 FROM orchestration.run_steps rs
      JOIN orchestration.runs r ON r.id = rs.run_id
      WHERE rs.id = run_step_id
        AND (
          r.triggered_by_user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM orchestration.approvals a
            WHERE a.run_id = r.id AND a.requested_from_user_id = auth.uid()
          )
        )
    )
  );

GRANT ALL ON orchestration.tool_calls TO service_role;
GRANT SELECT ON orchestration.tool_calls TO authenticated;

-- ─────────────────────────────────────────────
-- artifacts: files/blobs produced by runs
-- ─────────────────────────────────────────────
CREATE TABLE orchestration.artifacts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES orchestration.runs(id) ON DELETE CASCADE,
  run_step_id    uuid REFERENCES orchestration.run_steps(id),
  kind           text NOT NULL,         -- e.g. 'resume_pdf', 'assessment_memo'
  mime_type      text,
  storage_path   text NOT NULL,         -- Supabase Storage path
  size_bytes     integer,
  ops_only       boolean NOT NULL DEFAULT false,  -- hide from end users even if run visible
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX artifacts_run_id_idx ON orchestration.artifacts(run_id);

ALTER TABLE orchestration.artifacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON orchestration.artifacts
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role') = 'ops')
  WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

CREATE POLICY "enduser_read_if_run_visible_and_not_ops_only" ON orchestration.artifacts
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() ->> 'role') = 'enduser'
    AND ops_only = false
    AND EXISTS (
      SELECT 1 FROM orchestration.runs r
      WHERE r.id = run_id
        AND (
          r.triggered_by_user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM orchestration.approvals a
            WHERE a.run_id = r.id AND a.requested_from_user_id = auth.uid()
          )
        )
    )
  );

GRANT ALL ON orchestration.artifacts TO service_role;
GRANT SELECT ON orchestration.artifacts TO authenticated;

-- ─────────────────────────────────────────────
-- approvals: human-in-the-loop pause records
-- ─────────────────────────────────────────────
CREATE TYPE orchestration.approval_status AS ENUM (
  'pending', 'approved', 'rejected', 'expired'
);

CREATE TABLE orchestration.approvals (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                  uuid NOT NULL REFERENCES orchestration.runs(id) ON DELETE CASCADE,
  run_step_id             uuid REFERENCES orchestration.run_steps(id),
  requested_from_user_id  uuid,          -- specific user, if targeted
  requested_from_role     text,          -- or any user with this role
  prompt                  text NOT NULL, -- what the human is being asked to decide
  status                  orchestration.approval_status NOT NULL DEFAULT 'pending',
  decided_by              uuid,          -- auth.users(id)
  decided_at              timestamptz,
  decision_notes          text,
  expires_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX approvals_run_id_idx ON orchestration.approvals(run_id);
CREATE INDEX approvals_status_idx ON orchestration.approvals(status);
CREATE INDEX approvals_requested_from_user_id_idx ON orchestration.approvals(requested_from_user_id);

ALTER TABLE orchestration.approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON orchestration.approvals
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role') = 'ops')
  WITH CHECK ((auth.jwt() ->> 'role') = 'ops');

-- End users can read and update approvals assigned to them
CREATE POLICY "enduser_read_own" ON orchestration.approvals
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() ->> 'role') = 'enduser'
    AND (
      requested_from_user_id = auth.uid()
      OR requested_from_role = (auth.jwt() ->> 'role')
    )
  );

CREATE POLICY "enduser_decide_own" ON orchestration.approvals
  FOR UPDATE TO authenticated
  USING (
    (auth.jwt() ->> 'role') = 'enduser'
    AND status = 'pending'
    AND (
      requested_from_user_id = auth.uid()
      OR requested_from_role = (auth.jwt() ->> 'role')
    )
  )
  WITH CHECK (
    status IN ('approved', 'rejected')
    AND decided_by = auth.uid()
  );

GRANT ALL ON orchestration.approvals TO service_role;
GRANT SELECT, UPDATE ON orchestration.approvals TO authenticated;

-- ─────────────────────────────────────────────
-- updated_at trigger for orchestrations
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION orchestration.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON orchestration.orchestrations
  FOR EACH ROW EXECUTE FUNCTION orchestration.set_updated_at();
