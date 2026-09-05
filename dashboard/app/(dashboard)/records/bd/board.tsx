import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { PipelineBoardClient, type BoardCard } from "@/components/pipeline-board-client";

export const dynamic = "force-dynamic";

/**
 * BD pipeline board — the Kanban from the LumiAgents BD Figma, green-lit at the
 * 2026-09-01 syncup.
 *
 * Columns are the Bid-phase stages in the design's order; a card is an opportunity
 * a human has marked `pursue`. Nothing else appears here: `watch` stays on the
 * Opportunities list and `ignore` is hidden, which is what makes the board a
 * commitment rather than another inbox.
 */

export const STAGES = [
  { key: "response_outline",   label: "Response outline",   action: "Draft and review the response outline" },
  { key: "past_performance",   label: "Past performance",   action: "Map and add colour to PP" },
  { key: "reqs_reps_certs",    label: "Reqs / Reps / Certs", action: "Determine and create Reqs/Reps/Certs" },
  { key: "pricing",            label: "Pricing",            action: "Pricing guidance, then manual updates" },
  { key: "negotiate_mobilize", label: "Negotiate & mobilize", action: "Negotiate, then mobilize" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];

export function isStage(v: unknown): v is StageKey {
  return STAGES.some((s) => s.key === v);
}

/** A pursued opportunity that has never been placed belongs in the first column. */
const FIRST_STAGE: StageKey = STAGES[0].key;

export async function PipelineBoardTab() {
  const supabase = await createClient();

  /**
   * Move a card one column, or to a named stage.
   *
   * Bounded at both ends rather than wrapping: the last column is the end of this
   * board's responsibility, and silently sending a finished deal back to the start
   * would be worse than doing nothing.
   */
  async function moveCard(formData: FormData) {
    "use server";
    const id = String(formData.get("id") ?? "");
    const direction = String(formData.get("direction") ?? "");
    if (!id) throw new Error("moveCard: no id");

    const sb = await createClient();
    const { data: current } = await sb
      .from("opportunities").select("pipeline_stage, disposition").eq("id", id).single();
    if (!current) throw new Error("moveCard: opportunity not found");

    const keys = STAGES.map((s) => s.key) as StageKey[];
    const at = isStage(current.pipeline_stage) ? keys.indexOf(current.pipeline_stage) : 0;
    const next = direction === "back" ? Math.max(0, at - 1) : Math.min(keys.length - 1, at + 1);
    if (next === at && isStage(current.pipeline_stage)) return; // already at an end

    const { error } = await sb
      .from("opportunities")
      .update({ pipeline_stage: keys[next], pipeline_stage_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/records/bd");
  }

  const { data } = await supabase
    .from("opportunities")
    .select("id, title, agency, fit_score, recommendation, response_deadline, pipeline_stage, pipeline_stage_at, solicitation_number, source_url")
    .eq("disposition", "pursue")
    // Oldest movement first: a card nobody has touched in weeks should be the one
    // you see, not the one buried under this morning's additions.
    .order("pipeline_stage_at", { ascending: true, nullsFirst: true })
    .order("fit_score", { ascending: false, nullsFirst: false });

  const cards = (data ?? []).map((o) => ({
    ...o,
    pipeline_stage: isStage(o.pipeline_stage) ? o.pipeline_stage : FIRST_STAGE,
  })) as BoardCard[];

  return <PipelineBoardClient cards={cards} moveCard={moveCard} />;
}
