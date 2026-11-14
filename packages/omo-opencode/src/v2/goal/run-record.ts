// The engine's continuation guards read the ended run's messages (senpi `agent_end` `event.messages`). OpenCode 2 hands
// the idle hook none, so the run since the last settle is rebuilt in the engine's shape from the host's own events:
// one assistant message per step (`session.text.ended` text, the step's tool calls, `session.step.ended` finish), each
// followed by its tool results (`tool.hook("execute.after")`).
import type { EngineMessage } from "./engine"

const STOP_REASONS: Readonly<Record<string, string>> = {
  stop: "stop",
  length: "length",
  "tool-calls": "toolUse",
  error: "error",
  "content-filter": "error",
  unknown: "stop",
}

interface Step {
  readonly texts: string[]
  readonly calls: { readonly name: string; readonly arguments: unknown }[]
  readonly results: EngineMessage[]
  finish?: string
}

export interface EndedRun {
  readonly messages: readonly EngineMessage[]
  readonly lastStopReason: string | undefined
  readonly lastTurnWasMalformedToolUse: boolean
  readonly lastAssistantText: string
}

export const EMPTY_RUN: EndedRun = {
  messages: [],
  lastStopReason: undefined,
  lastTurnWasMalformedToolUse: false,
  lastAssistantText: "",
}

export interface ToolOutcome {
  readonly messageID: string
  readonly tool: string
  readonly input: unknown
  readonly error?: string
  readonly output?: unknown
}

function resultText(output: unknown): string {
  if (typeof output === "string") return output
  if (!Array.isArray(output)) return output === undefined ? "" : JSON.stringify(output)
  return output
    .map((part: unknown) => {
      const { type, text } = (part ?? {}) as { type?: unknown; text?: unknown }
      return type === "text" && typeof text === "string" ? text : String(type)
    })
    .join("\n")
}

export function createRunRecords() {
  const runs = new Map<string, Map<string, Step>>()
  const stepOf = (sessionID: string, messageID: string) => {
    let steps = runs.get(sessionID)
    if (!steps) runs.set(sessionID, (steps = new Map()))
    let step = steps.get(messageID)
    if (!step) steps.set(messageID, (step = { texts: [], calls: [], results: [] }))
    return step
  }
  return {
    text(sessionID: string, messageID: string, text: string): void {
      stepOf(sessionID, messageID).texts.push(text)
    },
    tool(sessionID: string, outcome: ToolOutcome): void {
      const step = stepOf(sessionID, outcome.messageID)
      step.calls.push({ name: outcome.tool, arguments: outcome.input })
      step.results.push({
        role: "toolResult",
        toolName: outcome.tool,
        isError: outcome.error !== undefined,
        content: [{ type: "text", text: outcome.error ?? resultText(outcome.output) }],
      })
    },
    stepEnded(sessionID: string, messageID: string, finish: string): void {
      stepOf(sessionID, messageID).finish = finish
    },
    take(sessionID: string): EndedRun {
      const steps = [...(runs.get(sessionID)?.values() ?? [])]
      runs.delete(sessionID)
      const messages: EngineMessage[] = []
      for (const step of steps) {
        messages.push({
          role: "assistant",
          ...(step.finish !== undefined && { stopReason: STOP_REASONS[step.finish] ?? step.finish }),
          content: [
            ...step.texts.map((text) => ({ type: "text" as const, text })),
            ...step.calls.map((call) => ({ type: "toolCall" as const, ...call })),
          ],
        })
        messages.push(...step.results)
      }
      const last = steps.at(-1)
      const lastStopReason = last?.finish === undefined ? undefined : (STOP_REASONS[last.finish] ?? last.finish)
      return {
        messages,
        lastStopReason,
        lastTurnWasMalformedToolUse: lastStopReason === "toolUse" && last?.calls.length === 0,
        lastAssistantText: last?.texts.join("\n") ?? "",
      }
    },
    forget(sessionID: string): void {
      runs.delete(sessionID)
    },
  }
}

export type RunRecords = ReturnType<typeof createRunRecords>
