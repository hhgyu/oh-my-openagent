import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { join } from "node:path"
import { Model } from "@opencode/plugin"
import type { SessionRetry } from "@opencode/plugin/promise/session"
import { createScriptedFactsPorts } from "./facts.test-support"
import { createManualTimers, flush } from "./kibitzer/test-support"
import { REFLECTION_AGENT_ID, REFLECTION_PERMISSIONS } from "./reflection-agent"
import {
  createReflectionChildHosting,
  reflectionChildJournalPath,
  type ReflectionChildLaunch,
} from "./reflection-child"
import {
  REFLECTION_FOREIGN_SESSION_MESSAGE,
  REFLECTION_MEMORY_TOOL_NAME,
  REFLECTION_TOOL_NAMES,
} from "./reflection-tools"
import {
  createReflectionFixture,
  refusal,
  runTool,
  toolContext,
  type ReflectionFixture,
} from "./reflection.test-support"

setDefaultTimeout(process.platform === "win32" ? 30_000 : 10_000)

const fixtures: ReflectionFixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

async function setup() {
  const fixture = await createReflectionFixture()
  fixtures.push(fixture)
  // The reflection port request carries the same fields as the facts one, so the facts doubles serve it.
  const ports = createScriptedFactsPorts()
  const timers = createManualTimers()
  const warnings: string[] = []
  const hosting = createReflectionChildHosting({
    host: { session: {} },
    createPort: (request) => ports.createPort(request),
    timers,
    warn: (message) => {
      warnings.push(message)
    },
  })
  const launch = (extra: Partial<ReflectionChildLaunch> = {}) =>
    hosting.launch(fixture.bound, {
      runId: "run-1",
      parentSessionId: "ses_root",
      worktreeDir: fixture.worktree.dir,
      transcriptPath: fixture.transcriptPath,
      request: { trigger: "manual", focus: "indentation" },
      deadlineMs: 60_000,
      ...extra,
    })
  return { fixture, ports, timers, warnings, hosting, launch }
}

const createInput = {
  command: "create",
  reason: "feat(reflection): tabs",
  file_path: "reference/tabs.md",
  description: "Indentation preference",
  file_text: "Tabs.\n",
}

describe("reflection child launcher", () => {
  test("#given a retryable first request failure #then the next variant starts after cleanup and attempts are reported", async () => {
    const { ports, launch } = await setup()
    const running = launch({
      model: "test/first",
      variant: "high",
      fallbacks: [{ model: "test/second", variant: "low" }],
    })
    const first = await ports.started(1)
    first.finish({ status: "error", message: "503: provider unavailable" })
    await flush()
    expect(ports.children).toHaveLength(2)
    const second = ports.children[1]
    expect(first.disposed).toBe(true)
    expect(first.start.model).toMatchObject({ variant: "high" })
    expect(second.start.model).toMatchObject({ id: "second", variant: "low" })
    second.finish()
    expect(await running).toMatchObject({ status: "completed", attemptedModels: ["test/first", "test/second"] })
  })
  test("#given a chained owned child #then only one same-model host retry is admitted and unrelated sessions are untouched", async () => {
    const { hosting, ports, launch } = await setup()
    const running = launch({ model: "test/first", fallbacks: [{ model: "test/second" }] })
    const first = await ports.started(1)
    const event = (sessionID: string) =>
      ({
        sessionID,
        agent: REFLECTION_AGENT_ID,
        model: Model.Ref.parse("test/first"),
        error: { name: "APIError", data: { statusCode: 503, message: "provider unavailable" } },
        attempt: 1,
        decision: { retry: true, delay: 10_000 },
      }) as SessionRetry
    const firstRetry = event(first.sessionID)
    const nextRetry = event(first.sessionID)
    const unrelated = event("ses_root")
    hosting.onRetry(firstRetry)
    hosting.onRetry(nextRetry)
    hosting.onRetry(unrelated)
    expect(firstRetry.decision).toEqual({ retry: true, delay: 2000 })
    expect(nextRetry.decision).toEqual({ retry: false })
    expect(unrelated.decision).toEqual({ retry: true, delay: 10_000 })
    first.finish()
    await running
  })
  test.each(["401: unauthorized", "400: invalid request", "403: rate limit permission denied"])(
    "#given %s #then the next model is never started",
    async (message) => {
      const { ports, launch } = await setup()
      const running = launch({ model: "test/first", fallbacks: [{ model: "test/second" }] })
      const first = await ports.started(1)
      first.finish({ status: "error", message })
      expect(await running).toMatchObject({ status: "failed", attemptedModels: ["test/first"] })
      expect(ports.children).toHaveLength(1)
      expect(first.disposed).toBe(true)
    },
  )
  test("#given a model unavailable rejection at start #then cleanup precedes the next model", async () => {
    const { ports, launch } = await setup()
    const create = ports.createPort
    let closed = false
    let calls = 0
    ports.createPort = (request) => {
      if (calls++ > 0) {
        expect(closed).toBe(true)
        return create(request)
      }
      return {
        start: async () => {
          throw Object.assign(new Error("model not found"), { statusCode: 404 })
        },
        close: async () => {
          closed = true
        },
      }
    }
    const running = launch({ model: "test/gone", fallbacks: [{ model: "test/second" }] })
    const child = await ports.started(1)
    child.finish()
    expect(await running).toMatchObject({ status: "completed", attemptedModels: ["test/gone", "test/second"] })
  })
  test("#given a child start that never answers #then the run deadline still closes the port", async () => {
    const { ports, timers, launch } = await setup()
    let closed = false
    ports.createPort = () => ({
      start: () => new Promise(() => undefined),
      close: async () => {
        closed = true
      },
    })
    const running = launch({ model: "test/first", deadlineMs: 1000, fallbacks: [{ model: "test/second" }] })
    await flush()
    timers.fire(1000)
    expect(await running).toMatchObject({ status: "deadline", attemptedModels: ["test/first"] })
    expect(closed).toBe(true)
  })
  test("#given time spent on the first rung #then the fallback only gets the remaining deadline", async () => {
    const { ports, timers, launch } = await setup()
    const now = spyOn(Date, "now").mockReturnValue(1000)
    try {
      const running = launch({ model: "test/first", deadlineMs: 1000, fallbacks: [{ model: "test/second" }] })
      const first = await ports.started(1)
      now.mockReturnValue(1700)
      first.finish({ status: "error", message: "503: unavailable" })
      const second = await ports.started(2)
      await flush()
      timers.fire(300)
      expect(await running).toMatchObject({ status: "deadline", attemptedModels: ["test/first", "test/second"] })
      expect(second.disposed).toBe(true)
    } finally {
      now.mockRestore()
    }
  })
  test("#given a retryable failure after the first request #then no fallback replays prior work", async () => {
    const { hosting, ports, launch } = await setup()
    const running = launch({ model: "test/first", fallbacks: [{ model: "test/second" }] })
    const first = await ports.started(1)
    hosting.onContext({
      sessionID: first.sessionID,
      tools: {},
      messages: [{ role: "assistant", content: [{ type: "text", text: "Prior work" }] }],
    })
    first.finish({ status: "error", message: "503: provider unavailable" })
    expect(await running).toMatchObject({ status: "failed", attemptedModels: ["test/first"] })
    expect(ports.children).toHaveLength(1)
  })
  test("#given a prepared run #when the child is launched #then the hidden agent is staged with the four tools, the task prompt and the identity journal", async () => {
    // given
    const { fixture, ports, launch } = await setup()

    // when
    const running = launch({ model: "test/model" })
    const child = await ports.started(1)
    child.finish()
    const result = await running

    // then
    const request = ports.requests[0]
    expect(request?.agent).toBe(REFLECTION_AGENT_ID)
    expect(request?.permissions).toEqual(REFLECTION_PERMISSIONS.map((rule) => ({ ...rule })))
    expect(request?.toolNames).toEqual([...REFLECTION_TOOL_NAMES])
    expect(request?.journalPath).toBe(join(fixture.bound.paths.reflection, "children.sqlite"))
    expect(request?.journalPath).toBe(reflectionChildJournalPath(fixture.bound))
    expect(child.start.prompt).toContain("Trigger: manual")
    expect(child.start.model).toEqual({ providerID: "test", id: "model" })
    expect(result.status).toBe("completed")
    expect(child.disposed).toBe(true)
  })

  test("#given a live child #when it and another session call the tools #then only the child reaches its run, and its commits are reported", async () => {
    // given
    const { hosting, ports, launch } = await setup()
    const memory = hosting.tools().find((tool) => tool.name === REFLECTION_MEMORY_TOOL_NAME)
    if (memory === undefined) throw new Error("reflection_memory missing")
    const running = launch()
    const child = await ports.started(1)

    // when
    const foreign = await refusal(runTool(memory, createInput, toolContext("ses_root")))
    const edited = await runTool(memory, createInput, toolContext(child.sessionID))
    child.finish()
    const result = await running
    const afterRun = await refusal(
      runTool(memory, { ...createInput, file_path: "reference/late.md" }, toolContext(child.sessionID)),
    )

    // then
    expect(foreign).toBe(`${REFLECTION_MEMORY_TOOL_NAME}: ${REFLECTION_FOREIGN_SESSION_MESSAGE}`)
    expect(result.commits).toHaveLength(1)
    expect(edited.metadata).toMatchObject({ commit: result.commits[0] })
    expect(afterRun).toBe(`${REFLECTION_MEMORY_TOOL_NAME}: ${REFLECTION_FOREIGN_SESSION_MESSAGE}`)
    expect(hosting.isReflectionSession(child.sessionID)).toBe(false)
  })

  test("#given model requests #when the context hook runs #then the child sees only its four tools and other sessions never see them", async () => {
    // given
    const { hosting, ports, launch } = await setup()
    const running = launch()
    const child = await ports.started(1)
    const all = () => Object.fromEntries(["bash", "read", ...REFLECTION_TOOL_NAMES].map((name) => [name, {}]))
    const childRequest = { sessionID: child.sessionID, tools: all() }
    const rootRequest = { sessionID: "ses_root", tools: all() }

    // when
    const childOwned = hosting.onContext(childRequest)
    const rootOwned = hosting.onContext(rootRequest)
    child.finish()
    await running

    // then
    expect(childOwned).toBe(true)
    expect(Object.keys(childRequest.tools).toSorted()).toEqual([...REFLECTION_TOOL_NAMES].toSorted())
    expect(rootOwned).toBe(false)
    expect(Object.keys(rootRequest.tools)).toEqual(["bash", "read"])
  })

  test("#given a child that never settles #when the deadline fires #then it is aborted, disposed and reported as deadline", async () => {
    // given
    const { ports, timers, launch } = await setup()
    const running = launch({ deadlineMs: 1_000 })
    const child = await ports.started(1)
    await flush()

    // when
    timers.fire(1_000)
    const result = await running

    // then
    expect(result.status).toBe("deadline")
    expect(child.aborts).toBe(1)
    expect(child.disposed).toBe(true)
  })

  test("#given a running child #when the parent cancels #then the port closes and the run reports cancelled", async () => {
    // given
    const { ports, launch } = await setup()
    let cancel: () => void = () => undefined
    const running = launch({
      onCancel: (registered) => {
        cancel = registered
      },
    })
    const child = await ports.started(1)

    // when
    cancel()
    const result = await running

    // then
    expect(result).toMatchObject({ status: "cancelled", commits: [] })
    expect(child.disposed).toBe(true)
  })

  test("#given a closed hosting #when a launch is requested #then nothing is started", async () => {
    // given
    const { hosting, ports, launch } = await setup()
    hosting.close()

    // when
    const result = await launch()

    // then
    expect(result).toEqual({ status: "cancelled", commits: [] })
    expect(ports.requests).toHaveLength(0)
  })
})
