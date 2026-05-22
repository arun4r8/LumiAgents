-- Migration: recreate public.agent_tasks
--
-- This table was dropped in 20260506000004_prune_and_harden.sql under the
-- assumption that it was superseded by the orchestration schema. However the
-- n8n resume-scoring workflow still writes to it as an intermediate step
-- immediately after creating the resume_jobs row — it inserts one row per job
-- so that downstream n8n nodes can track processing state.
--
-- Schema inferred from n8n "Create Agent Angie's Task" node field mappings:
--   id          — set to the resume_jobs.id UUID (one task per job)
--   source      — "n8n"
--   task_type   — "Resume Scoring"
--   payload     — JSON-stringified webhook body
--   agent       — "Angie"
--   status      — "pending" → updated by downstream n8n nodes
--
-- Rollback:
--   DROP TABLE IF EXISTS public.agent_tasks;

CREATE TABLE IF NOT EXISTS public.agent_tasks (
  id          uuid        PRIMARY KEY,
  source      text,
  task_type   text,
  payload     text,
  agent       text,
  status      text        NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON public.agent_tasks
  FOR ALL TO authenticated
  USING  (public.is_ops())
  WITH CHECK (public.is_ops());

GRANT ALL ON public.agent_tasks TO service_role;
