import type { SupabaseClient } from "../db/client";
import { MODELS } from "../config/models";

// Resolve which model an orchestration run should use: per-orchestration override →
// agent default → fallback. Shared by both the Workflow execution path (workflow.ts)
// and the inline/sync execution path (run-inline.ts) so they can't drift.
export async function resolveOrchestrationModel(
  db: SupabaseClient,
  orchestrationName: string,
): Promise<string> {
  const DEFAULT_MODEL: string = MODELS.sonnet;
  const agentId = orchestrationName.split("/")[0] ?? "";
  try {
    const [agentCfg, orchRow] = await Promise.all([
      db.getAgentConfig(agentId).catch(() => null),
      db.getOrchestrationByName(orchestrationName).catch(() => null),
    ]);
    return orchRow?.model ?? agentCfg?.model ?? DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}
