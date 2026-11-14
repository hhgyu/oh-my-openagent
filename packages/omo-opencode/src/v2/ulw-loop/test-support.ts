import type { ClassifiedLoopStatus } from "@oh-my-opencode/omo-codex/ulw-loop-session-sdk/loop-continuation"
import type { UlwLoopHost } from "./component"

type Callback = (input: never) => unknown
type Event = { readonly type: string; readonly data: { readonly sessionID: string } }

export function activeLoop(raw: string): ClassifiedLoopStatus {
  return { status: { raw, active: true } }
}

export const NO_LOOP: ClassifiedLoopStatus = { status: { raw: "", active: false, noPlan: true } }

export function fakeUlwLoopHost() {
  const hooks = new Map<string, Callback>()
  const synthetic: Record<string, unknown>[] = []
  const emitted: unknown[] = []
  const skills: { name: string }[] = []
  const pending: Event[] = []
  let wake: (() => void) | undefined
  const host = {
    location: { directory: "/project" },
    session: {
      hook: async (name: string, callback: Callback) => {
        hooks.set(name, callback)
        return { dispose: async () => void hooks.delete(name) }
      },
      synthetic: async (input: Record<string, unknown>) => {
        synthetic.push(input)
        return { id: String(input["id"]), sessionID: String(input["sessionID"]) }
      },
    },
    tool: {
      hook: async (name: string, callback: Callback) => {
        hooks.set(`tool.${name}`, callback)
        return { dispose: async () => void hooks.delete(`tool.${name}`) }
      },
    },
    rpc: {
      register: async () => ({
        events: { emit: async (_name: string, data: unknown) => void emitted.push(data) },
        dispose: async () => {},
      }),
    },
    skill: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ list: () => skills, add: (info: { name: string }) => skills.push(info) })
        return { dispose: async () => {} }
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
  } as unknown as UlwLoopHost
  const call = async (name: string, input: unknown) => (hooks.get(name) as (value: unknown) => unknown)(input)
  return {
    host,
    synthetic,
    emitted,
    skills,
    idle: (sessionID: string) => call("experimental.idle", { sessionID, background: [] }),
    prompt: async (sessionID: string, text: string, metadata?: Record<string, unknown>) => {
      const input = {
        sessionID,
        messageID: "msg_user",
        prompt: { text },
        delivery: "steer",
        ...(metadata && { metadata }),
      }
      await call("prompt", input)
      return input.prompt.text
    },
    event: async (type: string, sessionID: string) => {
      pending.push({ type, data: { sessionID } })
      wake?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}
