import type { SessionModelState } from "@oh-my-opencode/thread-core/control/port"
import { threadModel } from "../tools/thread-state"

export function sessionModelState(state: {
  readonly model?: unknown
  readonly thinkingLevel?: unknown
}): SessionModelState | undefined {
  const { model } = threadModel(state.model)
  return model && typeof state.thinkingLevel === "string" ? { model, thinkingLevel: state.thinkingLevel } : undefined
}
