-- Agent memory, Phase 1: durable conversations + transcripts, Teams identity
-- mapping, and retention/forget. Mirrors orchestration-schema conventions
-- (RLS: ops_all + owner-scoped; grants to service_role + authenticated).
-- Phase 2 (semantic recall) adds memory_chunks + match_memory; Phase 3 adds
-- summaries + memory_facts.
--
-- Rollback:
--   DROP FUNCTION orchestration.purge_expired_conversations(int);
--   DROP TABLE orchestration.messages, orchestration.conversations,
--              orchestration.teams_users CASCADE;

-- One conversation per (agent, user) thread. external_id holds the Teams
-- conversation id when the thread originates in Teams.
CREATE TABLE IF NOT EXISTS orchestration.conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_slug      text        NOT NULL,
  user_id         uuid,                       -- Lumiture user (auth.users); null for unmapped Teams
  external_id     text,                       -- Teams conversation id, when applicable
  title           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_external_uidx
  ON orchestration.conversations(agent_slug, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_user_agent_idx
  ON orchestration.conversations(user_id, agent_slug, last_message_at DESC);

CREATE TABLE IF NOT EXISTS orchestration.messages (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL REFERENCES orchestration.conversations(id) ON DELETE CASCADE,
  role            text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON orchestration.messages(conversation_id, created_at);

-- Teams identity → Lumiture user (AAD user id → auth.users.id), so Teams chats
-- attach to the same per-(user,agent) memory as the dashboard.
CREATE TABLE IF NOT EXISTS orchestration.teams_users (
  teams_user_id text        PRIMARY KEY,
  user_id       uuid,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── RLS: ops see all; users see only their own conversations/messages ─────────
ALTER TABLE orchestration.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration.messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration.teams_users   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_all" ON orchestration.conversations FOR ALL TO authenticated
  USING (public.is_ops()) WITH CHECK (public.is_ops());
CREATE POLICY "owner_rw" ON orchestration.conversations FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "ops_all" ON orchestration.messages FOR ALL TO authenticated
  USING (public.is_ops()) WITH CHECK (public.is_ops());
CREATE POLICY "owner_rw" ON orchestration.messages FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM orchestration.conversations c WHERE c.id = conversation_id AND c.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM orchestration.conversations c WHERE c.id = conversation_id AND c.user_id = auth.uid()));

CREATE POLICY "ops_all" ON orchestration.teams_users FOR ALL TO authenticated
  USING (public.is_ops()) WITH CHECK (public.is_ops());

GRANT ALL ON orchestration.conversations TO service_role;
GRANT ALL ON orchestration.messages      TO service_role;
GRANT ALL ON orchestration.teams_users   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON orchestration.messages      TO authenticated;

-- ─── Retention ────────────────────────────────────────────────────────────────
-- Purge conversations idle longer than p_days (cascades to messages, and to
-- memory_chunks once Phase 2 adds them). Driven by a daily schedule.
CREATE OR REPLACE FUNCTION orchestration.purge_expired_conversations(p_days int DEFAULT 180)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = orchestration AS $$
DECLARE n integer;
BEGIN
  DELETE FROM orchestration.conversations
   WHERE last_message_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION orchestration.purge_expired_conversations(int) FROM public;
GRANT EXECUTE ON FUNCTION orchestration.purge_expired_conversations(int) TO service_role;
