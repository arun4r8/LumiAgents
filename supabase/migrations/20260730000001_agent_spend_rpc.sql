-- agent_spend: per-agent, per-model LLM token usage over a trailing window.
--
-- Powers the "Spend by agent" panel on the Overview page (#77). Each row in
-- orchestration.run_steps records the model and input/output token counts for an
-- LLM step; each run links to an orchestration whose name is "<agent>/<orchestration>"
-- (agents: angie, beady, cleo, dewey, money, patch). This function rolls those steps
-- up to (agent, model) totals so the dashboard can price them client-side.
--
-- SECURITY DEFINER so authenticated dashboard users can read aggregate spend without
-- needing direct SELECT on the orchestration schema; only aggregate counts leave the
-- function, never prompt/response contents. Gated to ops users via public.is_ops():
-- SECURITY DEFINER bypasses RLS, so the gate is enforced in-function — a signed-in
-- enduser calling this RPC directly gets zero rows. is_ops() reads the caller's JWT
-- claims (request-scoped), which DEFINER does not alter, so it reflects the real caller.

CREATE OR REPLACE FUNCTION public.agent_spend(p_days int DEFAULT 30)
RETURNS TABLE(agent text, model text, input_tokens bigint, output_tokens bigint, calls bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, orchestration AS $$
  SELECT split_part(o.name, '/', 1) AS agent,
         COALESCE(rs.llm_model, 'unknown') AS model,
         COALESCE(SUM(rs.llm_input_tokens), 0)::bigint,
         COALESCE(SUM(rs.llm_output_tokens), 0)::bigint,
         COUNT(*)::bigint
  FROM orchestration.run_steps rs
  JOIN orchestration.runs r ON r.id = rs.run_id
  JOIN orchestration.orchestrations o ON o.id = r.orchestration_id
  WHERE public.is_ops()
    AND rs.llm_model IS NOT NULL
    AND rs.started_at >= now() - make_interval(days => p_days)
  GROUP BY 1, 2;
$$;

GRANT EXECUTE ON FUNCTION public.agent_spend(int) TO authenticated;
