import type { CommandDefinition, CommandInvocation } from "@opencode/plugin/promise/command"
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool"
import type { GoalHost, GoalTimers } from "./component"

type Callback = (input: never) => unknown
type Event = { readonly type: string; readonly data: Record<string, unknown> }

export interface FakeTimer {
  readonly ms: number
  readonly fire: () => Promise<void>
  cleared: boolean
}

export interface FakeGoalHost {
  readonly host: GoalHost
  readonly tools: readonly { readonly name: string; readonly input: unknown }[]
  readonly commands: readonly CommandDefinition[]
  readonly outputs: { readonly rpcID: string; readonly name: string; readonly data: unknown }[]
  readonly synthetic: Record<string, unknown>[]
  readonly timers: GoalTimers
  readonly armed: FakeTimer[]
  call(name: string, input: unknown, sessionID: string): Promise<Result>
  command(name: string, sessionID: string, text?: string): Promise<void>
  todowrite(sessionID: string, todos: readonly { content: string; status: string }[]): Promise<unknown>
  step(sessionID: string, tokens: { input: number; output: number; reasoning: number }): Promise<void>
  event(type: string, data: Record<string, unknown>): Promise<void>
  turn(sessionID: string, turn: { tools?: readonly ToolRun[]; text?: string; finish?: string }): Promise<void>
  idle(sessionID: string, background?: readonly unknown[]): Promise<unknown>
  prompt(sessionID: string, text: string, metadata?: Record<string, unknown>): Promise<string>
}

export interface ToolRun {
  readonly tool: string
  readonly input: unknown
  readonly output?: string
  readonly error?: string
}

export function fakeGoalHost(directory: string): FakeGoalHost {
  const tools: Info[] = []
  const commands: CommandDefinition[] = []
  const outputs: { rpcID: string; name: string; data: unknown }[] = []
  const hooks = new Map<string, Callback>()
  const subscribers = new Set<{ types: readonly string[]; pending: Event[]; wake: (() => void) | undefined }>()
  const synthetic: Record<string, unknown>[] = []
  const armed: FakeTimer[] = []
  let step = 0
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
    command: {
      transform: async (callback: (editor: unknown) => void) => {
        const added: CommandDefinition[] = []
        callback({ add: (definition: CommandDefinition) => added.push(definition) })
        commands.push(...added)
        return {
          dispose: async () => {
            for (const definition of added) commands.splice(commands.indexOf(definition), 1)
          },
        }
      },
    },
    rpc: {
      register: async (definition: { id: string }) => ({
        dispose: async () => {},
        events: {
          emit: async (name: string, data: unknown) => {
            outputs.push({ rpcID: definition.id, name, data: structuredClone(data) })
          },
        },
      }),
    },
    session: {
      hook: async (name: string, callback: Callback) => {
        hooks.set(name, callback)
        return { dispose: async () => void hooks.delete(name) }
      },
      synthetic: async (input: Record<string, unknown>) => {
        synthetic.push(input)
        return { id: String(input["id"]), sessionID: String(input["sessionID"]) }
      },
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, time: { updated: Date.now() } }),
    },
    event: {
      subscribe: ({ types, signal }: { types: readonly string[]; signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          const subscriber = { types, pending: [] as Event[], wake: undefined as (() => void) | undefined }
          subscribers.add(subscriber)
          signal.addEventListener("abort", () => subscriber.wake?.(), { once: true })
          try {
            while (!signal.aborted) {
              const next = subscriber.pending.shift()
              if (next) yield next
              else await new Promise<void>((resolve) => (subscriber.wake = resolve))
            }
          } finally {
            subscribers.delete(subscriber)
          }
        },
      }),
    },
  } as unknown as GoalHost
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const event = async (type: string, data: Record<string, unknown>) => {
    for (const subscriber of subscribers) {
      if (!subscriber.types.includes(type)) continue
      subscriber.pending.push({ type, data })
      subscriber.wake?.()
    }
    await settle()
  }
  const hook = (name: string) => hooks.get(name) as (input: unknown) => Promise<unknown>
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
  const timers: GoalTimers = {
    set: (callback, ms) => {
      const timer: FakeTimer = {
        ms,
        cleared: false,
        fire: async () => {
          if (!timer.cleared) await callback()
        },
      }
      armed.push(timer)
      return timer
    },
    clear: (handle) => {
      ;(handle as FakeTimer).cleared = true
    },
  }
  const command = async (name: string, sessionID: string, text = "") => {
    const definition = commands.find((entry) => entry.name === name)
    if (!definition) throw Error(`command ${name} is not registered`)
    await definition.execute({ sessionID, prompt: { text }, delivery: "steer" } as unknown as CommandInvocation)
    await settle()
  }
  return {
    host,
    tools,
    commands,
    outputs,
    synthetic,
    timers,
    armed,
    call,
    command,
    todowrite: async (sessionID, todos) =>
      hook("tool.execute.after")({ tool: "todowrite", sessionID, input: { todos }, status: "completed", result: {} }),
    step: async (sessionID, tokens) =>
      event("session.step.ended", {
        sessionID,
        assistantMessageID: `msg_a${step}`,
        finish: "stop",
        tokens: { ...tokens, cache: { read: 0, write: 0 } },
      }),
    event,
    turn: async (sessionID, { tools: runs = [], text, finish = "stop" }) => {
      const assistantMessageID = `msg_a${++step}`
      await event("session.step.started", { sessionID, assistantMessageID })
      for (const run of runs)
        await hook("tool.execute.after")({
          tool: run.tool,
          sessionID,
          messageID: assistantMessageID,
          input: run.input,
          ...(run.error === undefined
            ? { status: "completed", result: { content: run.output ?? "" } }
            : { status: "error", error: { message: run.error } }),
        })
      if (text !== undefined) await event("session.text.ended", { sessionID, assistantMessageID, ordinal: 0, text })
      await event("session.step.ended", {
        sessionID,
        assistantMessageID,
        finish,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    },
    idle: (sessionID, background = []) => hook("experimental.idle")({ sessionID, background }),
    prompt: async (sessionID, text, metadata) => {
      const input = {
        sessionID,
        messageID: "msg_user",
        prompt: { text },
        delivery: "steer",
        ...(metadata && { metadata }),
      }
      await hook("prompt")(input)
      return input.prompt.text
    },
  }
}
