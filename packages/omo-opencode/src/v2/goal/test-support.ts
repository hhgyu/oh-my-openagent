import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import type { GoalHost } from "./component"

type Callback = (input: never) => unknown
type Event = { readonly type: string; readonly data: Record<string, unknown> }

export function fakeGoalHost(directory: string) {
  const tools: Info[] = []
  const hooks = new Map<string, Callback>()
  const pending: Event[] = []
  let wake: (() => void) | undefined
  const host = {
    location: { directory },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ list: () => tools, add: (info: Info) => tools.push(info) })
        return { dispose: async () => {} }
      },
      hook: async (name: string, callback: Callback) => {
        hooks.set(`tool.${name}`, callback)
        return { dispose: async () => void hooks.delete(`tool.${name}`) }
      },
    },
    session: {
      hook: async (name: string, callback: Callback) => {
        hooks.set(name, callback)
        return { dispose: async () => void hooks.delete(name) }
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          signal.addEventListener("abort", () => wake?.(), { once: true })
          while (!signal.aborted) {
            const next = pending.shift()
            if (next) yield next
            else await new Promise<void>((resolve) => (wake = resolve))
          }
        },
      }),
    },
  } as unknown as GoalHost
  const call = async (name: string, input: unknown, sessionID: string) => {
    const tool = tools.find((entry) => entry.name === name)
    if (!tool) throw Error(`tool ${name} is not registered`)
    const context = {
      sessionID,
      agent: "sisyphus",
      messageID: "msg_1",
      id: `call_${name}`,
      signal: new AbortController().signal,
      progress: async () => {},
    } as unknown as ToolContext
    return tool.execute(input as never, context)
  }
  return {
    host,
    tools,
    call,
    todowrite: async (sessionID: string, todos: readonly { content: string; status: string }[]) =>
      (hooks.get("tool.execute.after") as (input: unknown) => unknown)({
        tool: "todowrite",
        sessionID,
        input: { todos },
        status: "completed",
      }),
    step: async (sessionID: string, tokens: { input: number; output: number; reasoning: number }) => {
      pending.push({ type: "session.step.ended", data: { sessionID, tokens: { ...tokens, cache: { read: 0, write: 0 } } } })
      wake?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}
