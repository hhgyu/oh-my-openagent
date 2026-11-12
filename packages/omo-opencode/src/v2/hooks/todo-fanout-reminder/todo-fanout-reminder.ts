import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { Result } from "@opencode/plugin/promise/tool"
import { sharedPromptArmingLedger, type PromptArmingLedger, type TodoFanoutArming } from "./prompt-arming"
import { TODO_FANOUT_REMINDER } from "./reminder"

type Host = Pick<Plugin.Context, "tool" | "session" | "event" | "options"> & Partial<Pick<Plugin.Context, "location">>

export interface TodoFanoutReminderOptions {
  /** Ultrawork arming ledger. Defaults to the shared directive and reminder ledger. */
  readonly arming?: TodoFanoutArming
}

const DISABLED_FLAG = "omo-senpi-todo-fanout-reminder-disabled"
// Senpi `todo` tool ops that add tasks; `view` / `done` never trigger the reminder.
const TASK_ADDING_OPS: ReadonlySet<string> = new Set(["init", "append"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * OpenCode 2 ships the experimental `todowrite` tool (flag `todo`), whose input replaces the whole
 * list, so any call carrying todos is the task-adding call. A Senpi-shaped `todo` tool keeps the
 * original op rule.
 */
function addsTodos(tool: string, input: unknown): boolean {
  if (!isRecord(input)) return false
  if (tool === "todo") return typeof input.op === "string" && TASK_ADDING_OPS.has(input.op)
  if (tool === "todowrite") return Array.isArray(input.todos) && input.todos.length > 0
  return false
}

function appendReminder(result: Result): Result {
  const content = result.content
  if (typeof content === "string") return { ...result, content: content ? `${content}\n\n${TODO_FANOUT_REMINDER}` : TODO_FANOUT_REMINDER }
  return { ...result, content: [...(content ?? []), { type: "text", text: TODO_FANOUT_REMINDER }] }
}

/**
 * Port of the Senpi `todo-fanout-reminder` component. Event mapping:
 * - Senpi `tool_result` (content transform) -> `tool.hook("execute.after")`, rewriting `event.result`.
 * - Senpi `session_compact` (accepted only) -> `session.compaction.ended` event; failed compactions
 *   publish `session.compaction.failed` instead, so they never reset the gate.
 * - Senpi `session_shutdown` -> `session.deleted` event.
 * - Senpi ultrawork arming (`input`/`context` handlers) -> `session.hook("prompt")` keyword ledger,
 *   unless the caller injects its own ledger.
 * No `session.prompt*` call is made: the reminder rides inside the tool result.
 */
export async function registerTodoFanoutReminder(context: Host, options: TodoFanoutReminderOptions = {}): Promise<() => Promise<void>> {
  if (context.options?.[DISABLED_FLAG] === true || context.options?.["omo-senpi-disabled"] === true ||
      process.env.OMO_SENPI_DISABLED === "1") return async () => {}
  let ownedLedger: PromptArmingLedger | undefined
  let arming: TodoFanoutArming
  if (options.arming === undefined) {
    ownedLedger = sharedPromptArmingLedger(context)
    arming = ownedLedger
  } else {
    arming = options.arming
  }
  const reminderLedger = ownedLedger ?? sharedPromptArmingLedger(context)
  const registrations: Registration[] = []
  const stop = new AbortController()
  let closed = false
  let pump: Promise<void> | undefined

  const forget = (sessionID: string) => {
    reminderLedger.resetReminder(sessionID)
  }

  let disposal: Promise<void> | undefined
  const cleanup = () => {
    if (disposal) return disposal
    closed = true
    stop.abort(new Error("Todo fan-out reminder disposed"))
    disposal = (async () => {
      const results = await Promise.allSettled(registrations.map(registration => registration.dispose()))
      if (pump) await pump
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Todo fan-out reminder cleanup failed")
    })()
    return disposal
  }

  try {
    if (ownedLedger) {
      registrations.push(await context.session.hook("prompt", event => {
        if (closed) return
        ownedLedger.observePrompt(event.sessionID, event.prompt.text)
      }))
    }
    registrations.push(await context.tool.hook("execute.after", event => {
      if (closed || event.status !== "completed" || !addsTodos(event.tool, event.input)) return
      if (!arming.isArmed(event.sessionID) || !reminderLedger.claimReminder(event.sessionID)) return
      event.result = appendReminder(event.result)
    }))
    pump = (async () => {
      try {
        for await (const event of context.event.subscribe({ types: ["session.compaction.ended", "session.deleted"], signal: stop.signal })) {
          if (closed) break
          forget(event.data.sessionID)
          if (event.type === "session.compaction.ended") ownedLedger?.compact(event.data.sessionID, event.id)
          else ownedLedger?.disarm(event.data.sessionID)
        }
      } catch (error) {
        if (!stop.signal.aborted) console.warn("[oh-my-openagent/v2] todo-fanout-reminder event stream failed", error)
      }
    })()
  } catch (error) {
    try { await cleanup() } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Todo fan-out reminder registration and rollback failed") }
    throw error
  }
  return cleanup
}
