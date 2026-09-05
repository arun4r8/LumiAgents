/**
 * The pipeline board's stages, in the order the LumiAgents BD Figma shows them.
 *
 * Lives in lib/ rather than beside the board's server component ON PURPOSE. The client
 * component needs these constants, and importing them from a module that also contains
 * a `"use server"` action pulls the server action into the client graph -- which
 * typechecks cleanly and then fails the Turbopack build with "Ecmascript file had an
 * error". `tsc` cannot see it; only the bundler can.
 *
 * So: constants here, server actions in board.tsx, and the client imports only this.
 */
export const STAGES = [
  { key: "response_outline",   label: "Response outline",     action: "Draft and review the response outline" },
  { key: "past_performance",   label: "Past performance",     action: "Map and add colour to PP" },
  { key: "reqs_reps_certs",    label: "Reqs / Reps / Certs",  action: "Determine and create Reqs/Reps/Certs" },
  { key: "pricing",            label: "Pricing",              action: "Pricing guidance, then manual updates" },
  { key: "negotiate_mobilize", label: "Negotiate & mobilize", action: "Negotiate, then mobilize" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];

export function isStage(v: unknown): v is StageKey {
  return STAGES.some((s) => s.key === v);
}

/** A pursued opportunity that has never been placed belongs in the first column. */
export const FIRST_STAGE: StageKey = STAGES[0].key;
