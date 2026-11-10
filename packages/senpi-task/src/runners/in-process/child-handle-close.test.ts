import { describe, expect, test } from "bun:test"
import { adaptInProcessHandle, releaseOnDispose } from "../../manager/child-handle"
import {
  createChildHandle,
  createRestoredChildHandle,
  createStagedChildHandle,
  discardUnstartedChildSession,
  type ChildHandle,
  type ChildSession,
} from "./child-handle"

// Controlled structural session ports; actual installed SDK coverage is separate.
function fixture(options: {
  join?: () => Promise<void>
  emit?: () => Promise<unknown>
  dispose?: () => void
  unsubscribe?: () => void
} = {}) {
  const events: string[] = []
  const session: ChildSession & { whenToolChildClosed?: () => Promise<void> } = {
    sessionId: "controlled-close-child",
    async prompt() {},
    async steer() { return "handled" },
    async followUp() { return "handled" },
    async abort() {},
    subscribe() { return () => { events.push("unsubscribe"); options.unsubscribe?.() } },
    getLastAssistantText() { return undefined },
    dispose() { expect(this).toBe(session); events.push("dispose"); options.dispose?.() },
  }
  if (options.join) session.whenToolChildClosed = function () {
    expect(this).toBe(session)
    events.push("join")
    return options.join!()
  }
  if (options.emit) {
    const runner = {
      hasHandlers(type: string) { expect(this).toBe(runner); return type === "session_shutdown" },
      async emit() { expect(this).toBe(runner); events.push("shutdown"); return options.emit!() },
    }
    Object.assign(session, { extensionRunner: runner })
  }
  return { session, events }
}

const restored = (session: ChildSession) => createRestoredChildHandle({ taskId: "close-test", session })

describe("Native optional tool-child close join", () => {
  test("absent join preserves synchronous disposal and one observer removal", async () => {
    const { session, events } = fixture()
    const handle = restored(session)
    const closing = handle.dispose()
    expect(events).toEqual(["unsubscribe", "dispose"])
    await closing
    await handle.dispose()
    expect(events).toEqual(["unsubscribe", "dispose"])
  })

  test("unstarted discard awaits the optional join after shutdown and synchronous dispose", async () => {
    const gate = Promise.withResolvers<void>()
    const { session, events } = fixture({ emit: async () => {}, join: () => gate.promise })
    let settled = false
    const closing = discardUnstartedChildSession(session)
    void closing.then(() => { settled = true })
    await Bun.sleep(0)
    const beforeRelease = { events: [...events], settled }
    gate.resolve()
    await closing
    expect(beforeRelease).toEqual({ events: ["shutdown", "dispose", "join"], settled: false })
    expect(settled).toBe(true)
  })

  test.each(["started", "staged", "restored"] as const)("%s handle shares one pending cleanup with every caller", async kind => {
    const gate = Promise.withResolvers<void>()
    const { session, events } = fixture({ join: () => gate.promise })
    const handle = kind === "started" ? createChildHandle({ taskId: "close-test", session, promptText: "unit" })
      : kind === "staged" ? createStagedChildHandle({ taskId: "close-test", session, promptText: "unit" }).handle
        : restored(session)
    const first = handle.dispose()
    const second = handle.dispose()
    let secondSettled = false
    void Promise.resolve(second).then(() => { secondSettled = true })
    await Bun.sleep(0)
    const settledBeforeRelease = secondSettled
    gate.resolve()
    await Promise.all([first, second])
    expect(first).toBe(second)
    expect(settledBeforeRelease).toBe(false)
    expect(events).toEqual(["unsubscribe", "dispose", "join"])
    expect(handle.dispose()).toBe(first)
  })

  test("reentrant observer removal sees the already reserved cleanup promise", async () => {
    let handle: ChildHandle
    let reentrant: ReturnType<ChildHandle["dispose"]> = undefined
    const { session, events } = fixture({ unsubscribe: () => { reentrant = handle.dispose() } })
    handle = restored(session)
    const first = handle.dispose()
    await first
    expect(reentrant === first).toBe(true)
    expect(events).toEqual(["unsubscribe", "dispose"])
  })

  test("a rejected optional join remains the same failure on repeated disposal", async () => {
    const failure = new Error("controlled join failure")
    const { session, events } = fixture({ join: async () => { throw failure } })
    const handle = restored(session)
    const first = handle.dispose() as Promise<void>
    expect(await first.catch(error => error)).toBe(failure)
    const second = handle.dispose() as Promise<void>
    expect(await second.catch(error => error)).toBe(failure)
    expect(second).toBe(first)
    expect(events).toEqual(["unsubscribe", "dispose", "join"])
  })

  test("original shutdown error identity survives a successful join", async () => {
    const failure = new Error("shutdown failed")
    const { session, events } = fixture({ emit: async () => { throw failure }, join: async () => {} })
    expect(await discardUnstartedChildSession(session).catch(error => error)).toBe(failure)
    expect(events).toEqual(["shutdown", "dispose", "join"])
  })

  test("absent optional port preserves the original shutdown error", async () => {
    const failure = new Error("original shutdown failure")
    const { session, events } = fixture({ emit: async () => { throw failure } })
    expect(await discardUnstartedChildSession(session).catch(error => error)).toBe(failure)
    expect(events).toEqual(["shutdown", "dispose"])
  })

  test("manager release cannot report closed after a failed join or repeated failed disposal", async () => {
    const failure = new Error("tool child close rejected")
    const { session, events } = fixture({ join: async () => { throw failure } })
    let released = 0
    const managed = releaseOnDispose(adaptInProcessHandle(restored(session)), () => { released++ })
    expect(await managed.dispose().catch(error => error)).toBe(failure)
    expect(await managed.dispose().catch(error => error)).toBe(failure)
    expect(released).toBe(0)
    expect(events).toEqual(["unsubscribe", "dispose", "join"])
  })

  test("synchronous dispose failure retains original finally precedence and never claims a join", async () => {
    const shutdown = new Error("shutdown failed")
    const disposal = new Error("sync dispose failed")
    const { session, events } = fixture({ emit: async () => { throw shutdown }, dispose: () => { throw disposal }, join: async () => {} })
    expect(await discardUnstartedChildSession(session).catch(error => error)).toBe(disposal)
    expect(events).toEqual(["shutdown", "dispose"])
  })

  test("two distinct cleanup failures are retained when the new join also rejects", async () => {
    const shutdown = new Error("shutdown failed")
    const join = new Error("join failed")
    const { session } = fixture({ emit: async () => { throw shutdown }, join: async () => { throw join } })
    const result = await discardUnstartedChildSession(session).catch(error => error)
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toEqual([shutdown, join])
    expect((result as AggregateError).cause).toBe(shutdown)
  })

  test("synchronous observer failure cannot become success on a later call", async () => {
    const failure = new Error("observer failed")
    const { session, events } = fixture({ unsubscribe: () => { throw failure } })
    const handle = restored(session)
    const first = handle.dispose() as Promise<void>
    expect(await first.catch(error => error)).toBe(failure)
    const second = handle.dispose() as Promise<void>
    expect(await second.catch(error => error)).toBe(failure)
    expect(events).toEqual(["unsubscribe"])
  })
})
