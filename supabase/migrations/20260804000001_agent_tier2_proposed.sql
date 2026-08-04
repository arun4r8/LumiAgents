-- Tier 2 agent builder (#67): a capability proposal opens a human-merge-gated PR and marks the
-- agent 'proposed' until an ops engineer reviews + merges. Widen the agents.lifecycle CHECK to
-- include 'proposed', and track the pending PR (url + number). The app only DRAFTS; the code
-- goes live only after a human merges the PR (deploy-worker.yml applies the seed migration then).
--
-- Forward-only. RLS unchanged: the agents ops_all policy already covers ops writes, and the
-- runtime records the pending PR via service_role (which bypasses RLS).
--
-- Rollback:
--   ALTER TABLE orchestration.agents DROP COLUMN IF EXISTS pending_pr_url;
--   ALTER TABLE orchestration.agents DROP COLUMN IF EXISTS pending_pr_number;
--   ALTER TABLE orchestration.agents DROP CONSTRAINT IF EXISTS agents_lifecycle_check;
--   ALTER TABLE orchestration.agents ADD CONSTRAINT agents_lifecycle_check
--     CHECK (lifecycle IN ('active', 'disabled'));

ALTER TABLE orchestration.agents DROP CONSTRAINT IF EXISTS agents_lifecycle_check;
ALTER TABLE orchestration.agents
  ADD CONSTRAINT agents_lifecycle_check
  CHECK (lifecycle IN ('active', 'disabled', 'proposed'));

ALTER TABLE orchestration.agents ADD COLUMN IF NOT EXISTS pending_pr_url    text;
ALTER TABLE orchestration.agents ADD COLUMN IF NOT EXISTS pending_pr_number int;
