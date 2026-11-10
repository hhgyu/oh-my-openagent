import { describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { isUltraworkPrompt, registerTodoFanoutReminder, TODO_FANOUT_REMINDER, type TodoFanoutArming } from "./index"

type Callback = (event: Record<string, unknown>) => void | Promise<void>
interface Queued { readonly event: unknown; readonly done: () => void }

function fakeHost(options: Record<string, unknown> = {}) {
  const hooks = new Map<string, Callback>()
  let registrations = 0, disposals = 0
  const queue: Queued[] = []
  let wake: (() => void) | undefined
  let subscribedTypes: readonly string[] = []
  let streamClosed!: () => void
  const closedStream = new Promise<void>(resolve => { streamClosed = resolve })
  const register = (domain: string) => async (name: string, callback: Callback) => {
    hooks.set(`${domain}:${name}`, callback); registrations++
    return { dispose: async () => { disposals++; hooks.delete(`${domain}:${name}`) } }
  }
  const host = {
    options,
    tool: { hook: register("tool") },
    session: { hook: register("session") },
    event: {
      subscribe: (subscription: { types: readonly string[]; signal: AbortSignal }) => {
        subscribedTypes = subscription.types
        return {
          async *[Symbol.asyncIterator]() {
            try {
              while (!subscription.signal.aborted) {
                const next = queue.shift()
                if (next) { yield next.event; next.done(); continue }
                await new Promise<void>(resolve => { wake = resolve; subscription.signal.addEventListener("abort", () => resolve(), { once: true }) })
              }
            } finally { streamClosed() }
          },
        }
      },
    },
  } as unknown as Parameters<typeof registerTodoFanoutReminder>[0]
  const fire = (key: string, event: Record<string, unknown>) => {
    const callback = hooks.get(key)
    if (callback) void callback(event)
    return event
  }
  return {
    host,
    hooks,
    subscribedTypes: () => subscribedTypes,
    closedStream,
    counts: () => [registrations, disposals],
    prompt: (sessionID: string, text: string) => fire("session:prompt", { sessionID, messageID: "m", prompt: { text }, delivery: "immediate" }),
    toolResult: (overrides: Record<string, unknown> = {}) => fire("tool:execute.after", {
      tool: "todowrite", sessionID: "s1", agent: "build", messageID: "m", id: "c",
      input: { todos: [{ content: "a", status: "pending" }] }, status: "completed",
      result: { content: [{ type: "text", text: "todos updated" }], metadata: { keep: 1 } }, ...overrides,
    }),
    emit: (type: string, sessionID: string) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`waited 2s for ${type} to be consumed, never was`)), 2000)
      queue.push({ event: { type, data: { sessionID } }, done: () => { clearTimeout(timer); resolve() } })
      wake?.()
    }),
  }
}

function reminderCount(event: Record<string, unknown>): number {
  const result = event.result as { content?: unknown }
  if (typeof result.content === "string") return result.content.split(TODO_FANOUT_REMINDER).length - 1
  if (!Array.isArray(result.content)) return 0
  return result.content.filter(item => item?.text === TODO_FANOUT_REMINDER).length
}

const armed = (ids: string[]): TodoFanoutArming => ({ isArmed: id => ids.includes(id) })

describe("v2 todo-fanout-reminder", () => {
  test("#given an ultrawork prompt #when the first and later todowrite results complete #then exactly one reminder is appended and host fields survive", async () => {
    // given
    const f = fakeHost()
    await registerTodoFanoutReminder(f.host)
    f.prompt("s1", "ulw fix the parser")

    // when
    const first = f.toolResult()
    const second = f.toolResult()

    // then
    expect(reminderCount(first)).toBe(1)
    const result = first.result as { content: unknown[]; metadata: unknown }
    expect(result.content[0]).toEqual({ type: "text", text: "todos updated" })
    expect(result.metadata).toEqual({ keep: 1 })
    expect(reminderCount(second)).toBe(0)
  })

  test("#given string tool content #when the reminder fires #then the original text is kept as the prefix", async () => {
    // given
    const f = fakeHost()
    await registerTodoFanoutReminder(f.host, { arming: armed(["s1"]) })

    // when
    const event = f.toolResult({ result: { content: "ORIGINAL" } })

    // then
    const content = (event.result as { content: string }).content
    expect(content.startsWith("ORIGINAL")).toBe(true)
    expect(reminderCount(event)).toBe(1)
  })

  test.each([
    ["plain request", "fix the parser"],
    ["double-quoted keyword", "what does \"ulw\" mean"],
    ["identifier segment", "rename mass-ulw-refactor"],
    ["negated invocation", "do not use ulw here."],
  ])("#given a prompt with %s #when a todowrite result completes #then no reminder is appended", async (_label, text) => {
    // given
    const f = fakeHost()
    await registerTodoFanoutReminder(f.host)
    f.prompt("s1", text)

    // when
    const event = f.toolResult()

    // then
    expect(reminderCount(event)).toBe(0)
  })

  test.each([
    ["error status", { status: "error", error: { message: "boom" }, result: undefined }],
    ["non-todo tool", { tool: "edit" }],
    ["empty todowrite list", { input: { todos: [] } }],
    ["senpi todo view op", { tool: "todo", input: { op: "view" } }],
  ])("#given an armed session #when the result is a %s #then nothing is appended and the gate stays open", async (_label, overrides) => {
    // given
    const f = fakeHost()
    await registerTodoFanoutReminder(f.host, { arming: armed(["s1"]) })

    // when
    const skipped = f.toolResult(overrides)
    const adding = f.toolResult({ tool: "todo", input: { op: "append" } })

    // then
    if (skipped.result !== undefined) expect(reminderCount(skipped)).toBe(0)
    expect(reminderCount(adding)).toBe(1)
  })

  test("#given two armed sessions #when each adds todos #then each gets its own single reminder", async () => {
    // given
    const f = fakeHost()
    await registerTodoFanoutReminder(f.host, { arming: armed(["s1", "s2"]) })

    // when
    const one = f.toolResult({ sessionID: "s1" })
    const two = f.toolResult({ sessionID: "s2" })

    // then
    expect([reminderCount(one), reminderCount(two)]).toEqual([1, 1])
  })

  test.each(["session.compaction.ended", "session.deleted"])("#given a reminded session with injected arming #when %s arrives #then the gate resets and the next adding result reminds again", async (type) => {
    // given
    const f = fakeHost()
    await registerTodoFanoutReminder(f.host, { arming: armed(["s1"]) })
    f.toolResult()

    // when
    await f.emit(type, "other")
    const unaffected = f.toolResult()
    await f.emit(type, "s1")
    const after = f.toolResult()

    // then
    expect(f.subscribedTypes()).toEqual(["session.compaction.ended", "session.deleted"])
    expect(reminderCount(unaffected)).toBe(0)
    expect(reminderCount(after)).toBe(1)
  })

  test("#given the owned prompt ledger #when an accepted compaction arrives #then the session is disarmed until another ultrawork prompt", async () => {
    // given
    const f = fakeHost()
    await registerTodoFanoutReminder(f.host)
    f.prompt("s1", "ultrawork ship it")
    f.toolResult()

    // when
    await f.emit("session.compaction.ended", "s1")
    const disarmed = f.toolResult()
    f.prompt("s1", "ulw continue")
    const rearmed = f.toolResult()

    // then
    expect(reminderCount(disarmed)).toBe(0)
    expect(reminderCount(rearmed)).toBe(1)
  })

  test("#given strict disable options or env #when registering #then no hook is registered", async () => {
    const prior = process.env.OMO_SENPI_DISABLED
    try {
      delete process.env.OMO_SENPI_DISABLED
      for (const key of ["omo-senpi-disabled", "omo-senpi-todo-fanout-reminder-disabled"]) {
        // given
        const f = fakeHost({ [key]: true })
        // when
        await registerTodoFanoutReminder(f.host)
        // then
        expect(f.counts()).toEqual([0, 0])
      }
      process.env.OMO_SENPI_DISABLED = "1"
      const g = fakeHost()
      await registerTodoFanoutReminder(g.host)
      expect(g.counts()).toEqual([0, 0])
    } finally { if (prior === undefined) delete process.env.OMO_SENPI_DISABLED; else process.env.OMO_SENPI_DISABLED = prior }
  })

  test("#given a registration #when cleanup runs twice #then every hook is disposed once and the event stream closes", async () => {
    // given
    const f = fakeHost()
    const close = await registerTodoFanoutReminder(f.host)
    f.prompt("s1", "ulw go")
    const captured = f.hooks.get("tool:execute.after")

    // when
    await close(); await close()

    // then
    expect(f.counts()).toEqual([2, 2])
    await f.closedStream
    const late = { tool: "todowrite", sessionID: "s1", input: { todos: [{}] }, status: "completed", result: { content: "x" } }
    await captured?.(late)
    expect(reminderCount(late)).toBe(0)
  })
})

describe("v2 todo-fanout-reminder parity with the Senpi component", () => {
  const senpiComponents = join(dirname(dirname(dirname(dirname(dirname(import.meta.dir))))), "omo-senpi", "src", "components")

  test("#given the Senpi reminder module #when compared #then the V2 copy is byte-identical", async () => {
    // when
    const senpi = await import(pathToFileURL(join(senpiComponents, "todo-fanout-reminder", "reminder.ts")).href) as { TODO_FANOUT_REMINDER: string }

    // then
    expect(TODO_FANOUT_REMINDER).toBe(senpi.TODO_FANOUT_REMINDER)
  })

  test("#given Senpi's ultrawork keyword rule #when both classify the same prompts #then they agree", async () => {
    // given
    const senpi = await import(pathToFileURL(join(senpiComponents, "ultrawork", "index.ts")).href) as { isUltraworkInput(text: string): boolean }
    const prompts = ["ulw", "ultrawork fix", "ulw-loop start", "ulwfoo", "mass-ulw-refactor", "see .omo/ulw/x", "`ulw`", "> ulw", "'ulw' test", "do not use ulw.", "[REPORT] ulw done", "https://x.dev/ulw", "ulw-plan.md"]

    // when
    const v2 = prompts.map(isUltraworkPrompt)

    // then
    expect(v2).toEqual(prompts.map(prompt => senpi.isUltraworkInput(prompt)))
  })
})
