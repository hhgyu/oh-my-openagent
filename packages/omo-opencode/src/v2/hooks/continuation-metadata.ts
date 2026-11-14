// Prompt metadata of the hidden continuations V2 delivers itself. A prompt carrying one is the host's own turn, never
// user input, so no continuation budget restarts on it.
export const ULW_LOOP_CONTINUATION_METADATA_KEY = "omoUlwLoopContinuation"
export const ULW_EXECUTE_CONTINUATION_METADATA_KEY = "omoUlwExecuteContinuation"
export const GOAL_CONTINUATION_METADATA_KEY = "omoGoalContinuation"
const KEYS = [ULW_LOOP_CONTINUATION_METADATA_KEY, ULW_EXECUTE_CONTINUATION_METADATA_KEY, GOAL_CONTINUATION_METADATA_KEY]

export function isOwnContinuation(metadata: Readonly<Record<string, unknown>> | undefined): boolean {
  return KEYS.some((key) => metadata?.[key] !== undefined)
}
