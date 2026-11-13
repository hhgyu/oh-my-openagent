import { describe, expect, test } from "bun:test"
import type { EvalSessionRuntime } from "./codemode-session"
import { createEvalSessionRegistry, type ProcessEvents } from "./codemode-session-registry"

function fakeRuntime() {
  const state = { disposed: 0, abandoned: 0 }
  const runtime: EvalSessionRuntime = {
    tool: { name: "eval", description: "", parameters: {}, execute: async () => ({ content: [] }) },
    bridgeEndpoint: () => undefined,
    exclusive: (_signal, work) => work(),
    dispose: async () => {
      state.disposed++
    },
    abandon: () => {
      state.abandoned++
    },
  }
  return { runtime, state }
}

function fakeProcess() {
  const listeners = new Map<string, Set<() => void>>()
  const events: ProcessEvents = {
    on(event, listener) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(listener)
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener)
    },
  }
  return {
    events,
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener()
    },
    count: (event: string) => listeners.get(event)?.size ?? 0,
  }
}

describe("eval session registry", () => {
  test("#given one session #when acquired concurrently #then one runtime is created and session deletion disposes it", async () => {
    // given
    const proc = fakeProcess()
    const made = fakeRuntime()
    let creations = 0
    const registry = createEvalSessionRegistry({
      processEvents: proc.events,
      create: async () => {
        creations++
        return made.runtime
      },
    })

    // when
    const [a, b] = await Promise.all([registry.acquire("ses_1"), registry.acquire("ses_1")])
    await registry.release("ses_1")
    await registry.release("ses_1")

    // then
    expect(a).toBe(b)
    expect(creations).toBe(1)
    expect(made.state.disposed).toBe(1)
    expect(registry.size()).toBe(0)
  })

  test("#given live sessions #when the plugin disposes #then every runtime is disposed, new ones are refused and process hooks are removed", async () => {
    // given
    const proc = fakeProcess()
    const first = fakeRuntime(),
      second = fakeRuntime()
    const registry = createEvalSessionRegistry({
      processEvents: proc.events,
      create: async (id) => (id === "a" ? first.runtime : second.runtime),
    })
    await registry.acquire("a")
    await registry.acquire("b")
    expect(proc.count("exit")).toBe(1)

    // when
    await Promise.all([registry.dispose(), registry.dispose()])
    const refused = await registry.acquire("c").catch((error: unknown) => error)

    // then
    expect([first.state.disposed, second.state.disposed]).toEqual([1, 1])
    expect((refused as Error).message).toBe("eval is shutting down")
    expect(proc.count("exit")).toBe(0)
    expect(proc.count("beforeExit")).toBe(0)
  })

  test("#given the process exits without plugin dispose #when exit fires #then live runtimes are abandoned synchronously and creations are aborted", async () => {
    // given
    const proc = fakeProcess()
    const live = fakeRuntime()
    let pendingSignal: AbortSignal | undefined
    const registry = createEvalSessionRegistry({
      processEvents: proc.events,
      create: (id, signal) => {
        if (id === "live") return Promise.resolve(live.runtime)
        pendingSignal = signal
        return new Promise<EvalSessionRuntime>(() => {})
      },
    })
    await registry.acquire("live")
    void registry.acquire("starting")

    // when
    proc.emit("exit")

    // then
    expect(live.state.abandoned).toBe(1)
    expect(pendingSignal?.aborted).toBe(true)
  })

  test("#given a session deleted while its runtime is starting #when the creation finishes #then the late runtime is disposed and never handed out", async () => {
    // given
    const made = fakeRuntime()
    const gate = Promise.withResolvers<EvalSessionRuntime>()
    let signal: AbortSignal | undefined
    const registry = createEvalSessionRegistry({
      processEvents: fakeProcess().events,
      create: (_id, given) => {
        signal = given
        return gate.promise
      },
    })
    const acquiring = registry.acquire("ses_1")

    // when
    const released = registry.release("ses_1")
    gate.resolve(made.runtime)
    await released
    await acquiring

    // then
    expect(signal?.aborted).toBe(true)
    expect(made.state.disposed).toBeGreaterThanOrEqual(1)
    expect(registry.size()).toBe(0)
  })

  test("#given a creation that hangs #when the start timeout passes #then the caller gets an error and a late runtime is still disposed", async () => {
    // given
    const made = fakeRuntime()
    const gate = Promise.withResolvers<EvalSessionRuntime>()
    const registry = createEvalSessionRegistry({
      processEvents: fakeProcess().events,
      createTimeoutMs: 20,
      create: () => gate.promise,
    })

    // when
    const error = await registry.acquire("ses_1").catch((caught: unknown) => caught)
    gate.resolve(made.runtime)
    await Bun.sleep(5)

    // then
    expect((error as Error).message).toContain("did not start within")
    expect(registry.size()).toBe(0)
    expect(made.state.disposed).toBe(1)
  })

  test("#given a runtime whose dispose hangs #when the session is released #then cleanup is bounded", async () => {
    // given
    const made = fakeRuntime()
    const registry = createEvalSessionRegistry({
      processEvents: fakeProcess().events,
      disposeTimeoutMs: 20,
      create: async () => ({ ...made.runtime, dispose: () => new Promise<void>(() => {}) }),
    })
    await registry.acquire("ses_1")

    // when
    const error = await registry.release("ses_1").catch((caught: unknown) => caught)

    // then
    expect((error as Error).message).toContain("did not dispose within 20 ms")
  })
})
