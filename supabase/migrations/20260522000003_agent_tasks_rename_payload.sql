-- Migration: rename agent_tasks.payload → input_json
--
-- Our recreate migration used "payload" but n8n's "Create Agent Angie's Task"
-- node writes to a column called "input_json". Rename to match.
--
-- Rollback:
--   ALTER TABLE public.agent_tasks RENAME COLUMN input_json TO payload;

ALTER TABLE public.agent_tasks RENAME COLUMN payload TO input_json;
