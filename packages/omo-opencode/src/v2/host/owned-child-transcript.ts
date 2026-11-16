import type { Context } from "@opencode/plugin/promise/plugin"

type SessionMessage = Awaited<ReturnType<Context["session"]["context"]>>[number]

const BOOKKEEPING: ReadonlySet<string> = new Set([
  "idle",
  "agent-switched",
  "model-switched",
  "location-switched",
  "compaction",
])

/** Native `sessionTailFinishedText` over the host transcript (`session.context`): the final answer of a
 * turn that already ended, when the last conversation message is an assistant reply that finished with
 * `stop`, carries text and no unfinished tool call. Anything else (an input after it, a failed, cut or
 * still streaming reply, an unreadable transcript) gives nothing, so the caller keeps its own verdict. */
export function finishedTurnText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message: unknown = messages[index]
    if (!isMessage(message)) return undefined
    if (BOOKKEEPING.has(message.type)) continue
    if (message.type !== "assistant") return undefined
    if (message.finish !== "stop" || message.error !== undefined || message.time?.completed === undefined)
      return undefined
    if (!Array.isArray(message.content)) return undefined
    if (message.content.some((part) => part.type === "tool" && part.state?.status !== "completed")) return undefined
    const text = message.content
      .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("")
    return text.length > 0 ? text : undefined
  }
  return undefined
}

function isMessage(value: unknown): value is SessionMessage {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
}
