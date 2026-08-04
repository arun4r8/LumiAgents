-- Atomic create/update for config agents (#114, follow-up to #67 Tier 1).
--
-- The dashboard's createAgent/updateAgent fanned out across four tables via separate
-- PostgREST calls (agents, agent_configs, agent_config_overrides, agent_tools) with no
-- cross-table transaction — a mid-write failure could leave a partial agent, mitigated
-- only by validation-first + a compensating delete. This RPC does the whole write in one
-- function body, so it commits or rolls back as a unit.
--
-- SECURITY DEFINER + is_ops() gate: the write bypasses RLS inside the function but is
-- ops-only (is_ops() reads the caller's JWT, which DEFINER does not alter). auth.uid()
-- likewise reflects the real caller, so owner/created_by/updated_by are correct.
--
-- p_tools: a JSON array of {orchestration_name, params, mode}; position is the array order.
--
-- Rollback: DROP FUNCTION orchestration.save_config_agent(text,text,jsonb,jsonb,text,int,text,jsonb,boolean);

CREATE OR REPLACE FUNCTION orchestration.save_config_agent(
  p_slug              text,
  p_display_name      text,
  p_card              jsonb,
  p_knowledge_corpora jsonb,
  p_model             text,
  p_max_tokens        int,
  p_system_prompt     text,
  p_tools             jsonb,
  p_is_create         boolean
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = orchestration, public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_source text;
  v_tool   jsonb;
  v_pos    int := 0;
BEGIN
  IF NOT public.is_ops() THEN
    RAISE EXCEPTION 'Forbidden: ops only';
  END IF;

  IF p_is_create THEN
    -- Unique-violation on an existing slug raises and rolls back the whole call.
    INSERT INTO orchestration.agents
      (slug, display_name, card, source, lifecycle, knowledge_corpora, owner, created_by)
    VALUES
      (p_slug, p_display_name, p_card, 'config', 'active', p_knowledge_corpora, v_uid, v_uid);
  ELSE
    SELECT source INTO v_source FROM orchestration.agents WHERE slug = p_slug;
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Unknown agent: %', p_slug;
    END IF;
    IF v_source <> 'config' THEN
      RAISE EXCEPTION 'Built-in agents are edited from their Customize panel.';
    END IF;
    UPDATE orchestration.agents
       SET display_name      = p_display_name,
           card              = p_card,
           knowledge_corpora = p_knowledge_corpora,
           updated_at        = now()
     WHERE slug = p_slug;
  END IF;

  -- model / max_tokens (Tier 0 config table)
  INSERT INTO orchestration.agent_configs (agent_id, model, max_tokens, updated_at, updated_by)
  VALUES (p_slug, p_model, p_max_tokens, now(), v_uid)
  ON CONFLICT (agent_id) DO UPDATE
    SET model       = EXCLUDED.model,
        max_tokens  = EXCLUDED.max_tokens,
        updated_at  = EXCLUDED.updated_at,
        updated_by  = EXCLUDED.updated_by;

  -- persona: a 'replace' override (versioned; append a new row)
  INSERT INTO orchestration.agent_config_overrides
    (agent_id, system_prompt, prompt_strategy, enabled_tools, updated_by)
  VALUES
    (p_slug, NULLIF(btrim(p_system_prompt), ''), 'replace', NULL, v_uid);

  -- tools: replace the whole set (delete + insert in array order)
  DELETE FROM orchestration.agent_tools WHERE agent_slug = p_slug;
  IF p_tools IS NOT NULL THEN
    FOR v_tool IN SELECT * FROM jsonb_array_elements(p_tools) LOOP
      INSERT INTO orchestration.agent_tools
        (agent_slug, orchestration_name, params, mode, position)
      VALUES (
        p_slug,
        v_tool ->> 'orchestration_name',
        CASE WHEN v_tool -> 'params' IS NULL OR v_tool -> 'params' = 'null'::jsonb
             THEN NULL ELSE v_tool -> 'params' END,
        COALESCE(v_tool ->> 'mode', 'async'),
        v_pos
      );
      v_pos := v_pos + 1;
    END LOOP;
  END IF;

  RETURN p_slug;
END;
$$;

GRANT EXECUTE ON FUNCTION orchestration.save_config_agent(text,text,jsonb,jsonb,text,int,text,jsonb,boolean) TO authenticated;
