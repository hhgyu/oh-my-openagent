import type * as Plugin from "@opencode/plugin/promise/plugin"

const GOAL_EVENTS = [
  "session.step.started",
  "session.step.ended",
  "session.text.ended",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
] as const

type Tokens = { input?: number; output?: number; reasoning?: number }

export interface GoalEventHandlers {
  stepStarted(sessionID: string): void
  stepEnded(sessionID: string, messageID: string, finish: string, tokens: Tokens): void
  text(sessionID: string, messageID: string, text: string): void
  executionStarted(sessionID: string): void
  executionEnded(sessionID: string): void
  interrupted(sessionID: string, reason: string): Promise<void>
  deleted(sessionID: string): void
}

export async function pumpGoalEvents(
  events: Plugin.Context["event"],
  signal: AbortSignal,
  handlers: GoalEventHandlers,
): Promise<void> {
  for await (const event of events.subscribe({ types: [...GOAL_EVENTS], signal })) {
    const data = event.data as Record<string, unknown> & { sessionID: string }
    const { sessionID } = data
    switch (event.type) {
      case "session.step.started":
        handlers.stepStarted(sessionID)
        break
      case "session.step.ended":
        handlers.stepEnded(
          sessionID,
          String(data["assistantMessageID"]),
          String(data["finish"] ?? "stop"),
          (data["tokens"] ?? {}) as Tokens,
        )
        break
      case "session.text.ended":
        handlers.text(sessionID, String(data["assistantMessageID"]), String(data["text"] ?? ""))
        break
      case "session.execution.started":
        handlers.executionStarted(sessionID)
        break
      case "session.execution.interrupted":
        await handlers.interrupted(sessionID, String(data["reason"]))
        break
      case "session.deleted":
        handlers.deleted(sessionID)
        break
      default:
        handlers.executionEnded(sessionID)
    }
  }
}
