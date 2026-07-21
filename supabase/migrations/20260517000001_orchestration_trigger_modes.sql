-- Add trigger_mode to orchestrations.
-- "manual" = user triggers via dashboard Run button (default).
-- "agent"  = only triggerable via agent chat; card is informational in dashboard.
--
-- Also removes orchestrations that are not meaningful as dashboard-triggered
-- workflows. They stay in the runtime registry for agent dispatch.

ALTER TABLE orchestration.orchestrations
  ADD COLUMN IF NOT EXISTS trigger_mode text NOT NULL DEFAULT 'manual';

-- Mark agent-only orchestrations (visible in dashboard, no Run button).
UPDATE orchestration.orchestrations
SET trigger_mode = 'agent'
WHERE name IN (
  'angie/resume-formatting',
  'angie/resume-scoring',
  'beady/past-performance-seed'
);

-- Remove orchestrations that are not user-triggered workflows.
-- They remain in the runtime registry and are callable by agents.
DELETE FROM orchestration.orchestrations
WHERE name IN (
  'money/data-analyst',
  'money/financial-report',
  'patch/document-query',
  'patch/inbound-triage'
);
