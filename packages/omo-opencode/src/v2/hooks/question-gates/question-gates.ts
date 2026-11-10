import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { matchGate, type GateMatch } from "./gate-rule"

type Host = Pick<Plugin.Context, "tool" | "session" | "options">

const DISABLED_FLAG = "omo-senpi-question-gates-disabled"
// OpenCode 2 ships `question`; the Senpi names stay matched for a plugin that provides them.
const QUESTION_TOOLS: ReadonlySet<string> = new Set(["question", "ask_user_question", "request_user_input"])
const MAX_PENDING_GATES = 256
const GATE_MARKER = "omo.question-gate"

// Senpi's refusal for a required question settled without an answer
// (@code-yeongyu/senpi dist/core/extensions/builtin/ask-user/format.js `GATED_NO_ANSWER`).
export const GATED_NO_ANSWER = "No answer: do not take the action it gates. Keep that action pending and end the turn."

/**
 * Port of the Senpi `question-gates` component. Senpi forces `required: true` on a gating
 * `tool_call` so senpi's ask-user tool answers a no-answer settlement with GATED_NO_ANSWER instead
 * of "continue on your best judgment". OpenCode 2's question input (`Question.Prompt`) has no
 * `required` field, so the input is never rewritten (an unknown key could fail input decoding).
 * Event mapping instead:
 * - Senpi `tool_call` -> `tool.hook("execute.before")`: classify the call with the same gate rule.
 * - senpi's required no-answer wording -> `tool.hook("execute.after")` with `status: "error"`
 *   (a dismissed or failed question): the tool error is replaced by one that keeps the original
 *   message and appends GATED_NO_ANSWER. Answered questions pass through untouched.
 * - Actual 2.2.6: a DISMISSED question aborts the step with no `execute.after` at all. A gated call
 *   that never settled is therefore carried to the session's next model request through
 *   `session.hook("context")`, which receives GATED_NO_ANSWER once as a tagged system part.
 */
export async function registerQuestionGates(context: Host): Promise<() => Promise<void>> {
  if (context.options?.[DISABLED_FLAG] === true || context.options?.["omo-senpi-disabled"] === true ||
      process.env.OMO_SENPI_DISABLED === "1") return async () => {}
  const pending = new Map<string, GateMatch>()
  const registrations: Registration[] = []
  let closed = false
  let disposal: Promise<void> | undefined
  const cleanup = () => {
    if (disposal) return disposal
    closed = true
    disposal = (async () => {
      const results = await Promise.allSettled(registrations.map(registration => registration.dispose()))
      pending.clear()
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Question gates cleanup failed")
    })()
    return disposal
  }
  try {
    registrations.push(await context.tool.hook("execute.before", event => {
      if (closed || !QUESTION_TOOLS.has(event.tool)) return
      const gate = matchGate(event.input)
      if (gate === undefined) return
      pending.set(`${event.sessionID}:${event.id}`, gate)
      if (pending.size > MAX_PENDING_GATES) {
        const oldest = pending.keys().next().value
        if (oldest !== undefined) pending.delete(oldest)
      }
    }))
    registrations.push(await context.session.hook("context", value => {
      if (closed) return
      const prefix = `${value.sessionID}:`
      const unsettled = [...pending.keys()].filter(key => key.startsWith(prefix))
      if (unsettled.length === 0) return
      for (const key of unsettled) pending.delete(key)
      if (value.system.some(part => part.metadata?.[GATE_MARKER] === true)) return
      value.system.push({ type: "text", text: GATED_NO_ANSWER, metadata: { [GATE_MARKER]: true } })
    }))
    registrations.push(await context.tool.hook("execute.after", event => {
      const key = `${event.sessionID}:${event.id}`
      const gate = pending.get(key)
      if (gate === undefined) return
      pending.delete(key)
      if (closed || event.status !== "error" || event.error.message.includes(GATED_NO_ANSWER)) return
      const original = event.error
      event.error = new ToolError({
        message: original.message ? `${original.message}\n${GATED_NO_ANSWER}` : GATED_NO_ANSWER,
        ...(original.error === undefined ? {} : { error: original.error }),
        metadata: { ...original.metadata, omoQuestionGate: { rule: gate.rule, header: gate.header ?? null } },
      })
    }))
  } catch (error) {
    try { await cleanup() } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Question gates registration and rollback failed") }
    throw error
  }
  return cleanup
}
