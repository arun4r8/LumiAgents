// Single source of truth for the Claude model IDs used across LumiAgents.
// `sonnet` and `haiku` are the app's chosen aliases; import these constants
// instead of hardcoding model-id strings anywhere else in the codebase.
export const MODELS = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];
