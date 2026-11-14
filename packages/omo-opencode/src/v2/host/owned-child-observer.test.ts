import { describe, expect, test } from "bun:test"
import { withJoinedSessionCancellation } from "./session-cancellation"
import { createOwnedChildObserver } from "./owned-child-observer"
import type {
  OwnedChildObservationStore,
  ObservationRecord,
  ObservationSnapshot,
} from "./owned-child-observation-types"
import type { ChildHandle } from "./session-backend"
import type { OwnedChildObserverOptions } from "./owned-child-observer"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolDomain } from "@opencode/plugin/effect/tool"
import type { Effect as EffectModule } from "effect"

type HookCallback = (input: unknown) => unknown
type FakeSession = {
  hook: (name: string, callback: HookCallback) => Promise<{ dispose(): void }>
  update: (input: { title?: string }, options: { signal: AbortSignal }) => Promise<unknown>
}
type ObserverHost = Pick<Context, "session" | "event">

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}
async function settleStream() {
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}
function manualConfirmation() {
  const armed: (() => void)[] = []
  return {
    schedule(run: () => void) {
      armed.push(run)
      return {
        cancel: () => {
          const at = armed.indexOf(run)
          if (at >= 0) armed.splice(at, 1)
        },
      }
    },
    async fire() {
      for (const run of armed.splice(0)) run()
      await settleStream()
    },
    armed: () => armed.length,
  }
}
function fixture(emitBarrier = true) {
  const lifetime = new AbortController()
  let live = true,
    sequence = 0,
    ended = false,
    hookDisposed = 0,
    streamClosed = 0
  const hooks = new Map<string, HookCallback>()
  const queue: unknown[] = []
  let wake: ((value: IteratorResult<unknown>) => void) | undefined
  const child = {
    locator: {
      format: 1,
      backendID: "test",
      location: "/project",
      hostVersion: "2.2.6",
      parentID: "parent",
      sessionID: "child",
      generation: 1,
    },
    lease: { sessionID: "child", generation: 2, signal: lifetime.signal },
  } as ChildHandle
  const binding = { key: "task", token: "binding", locator: child.locator }
  const records: ObservationRecord[] = []
  const uncertainty: string[] = []
  const guard = () => {
    if (!live || lifetime.signal.aborted) throw Error("custody lost")
  }
  const store: OwnedChildObservationStore = {
    bind(input) {
      input.guard()
      return {
        binding,
        append(record) {
          input.guard()
          records.push(structuredClone(record))
        },
        snapshot(): ObservationSnapshot {
          input.guard()
          return { binding, records: structuredClone(records), uncertainty: [...uncertainty] }
        },
        invalidate(reason) {
          uncertainty.push(reason)
        },
      }
    },
    close() {},
  }
  function end() {
    ended = true
    if (wake) {
      wake({ done: true, value: undefined })
      wake = undefined
    }
  }
  function emit(type: string, data: Record<string, unknown> = {}) {
    const value = {
      id: `evt_${sequence}`,
      type,
      created: sequence,
      durable: { aggregateID: "child", seq: sequence++, version: 1 },
      data: { sessionID: "child", ...data },
    }
    if (wake) {
      const yes = wake
      wake = undefined
      yes({ done: false, value })
    } else queue.push(value)
  }
  const session: FakeSession = {
    async hook(name, callback) {
      hooks.set(name, callback)
      return {
        dispose() {
          hookDisposed++
          hooks.delete(name)
        },
      }
    },
    async update({ title }) {
      if (emitBarrier) emit("session.title.updated", { title })
    },
  }
  const ctx = {
    event: {
      subscribe({ signal }: { signal: AbortSignal }) {
        signal.addEventListener("abort", end, { once: true })
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (queue.length) return { done: false, value: queue.shift() }
                if (ended) return { done: true, value: undefined }
                return new Promise<IteratorResult<unknown>>((yes) => (wake = yes))
              },
              async return() {
                streamClosed++
                end()
                return { done: true, value: undefined }
              },
            }
          },
        }
      },
    },
    session,
  } as unknown as ObserverHost
  withJoinedSessionCancellation(session, "controlled-test")
  const options = { key: "task", child, guard, store, title: "Actual task title", timeoutMs: 1000 }
  async function finish(text = "final") {
    await hooks.get("model.request")?.({
      sessionID: "child",
      kind: "primary",
      model: { providerID: "actual", id: "observed" },
    })
    emit("session.execution.started")
    emit("session.inbox.delivered", { inboxID: "own" })
    emit("session.step.started", {
      assistantMessageID: "assistant",
      agent: "build",
      model: { providerID: "actual", id: "observed" },
    })
    emit("session.text.started", { assistantMessageID: "assistant", ordinal: 0 })
    emit("session.text.ended", { assistantMessageID: "assistant", ordinal: 0, text })
    emit("session.step.ended", {
      assistantMessageID: "assistant",
      finish: "stop",
      tokens: { input: 1, output: 2 },
      cost: 0,
    })
    emit("session.execution.succeeded")
  }
  let rawSequence = 0
  function emitRaw(value: Record<string, unknown>) {
    const event = { id: `raw_${rawSequence}`, created: rawSequence++, ...value }
    if (wake) {
      const yes = wake
      wake = undefined
      yes({ done: false, value: event })
    } else queue.push(event)
  }
  async function idle(background: readonly Record<string, unknown>[] = []) {
    await hooks.get("experimental.idle")?.({ sessionID: "child", background })
  }
  async function run(input: { message: string; text: string; inbox?: string; background?: Record<string, unknown>[] }) {
    emit("session.execution.started")
    if (input.inbox) emit("session.inbox.delivered", { inboxID: input.inbox })
    emit("session.step.started", {
      assistantMessageID: input.message,
      agent: "build",
      model: { providerID: "actual", id: "observed" },
    })
    emit("session.text.started", { assistantMessageID: input.message, ordinal: 0 })
    emit("session.text.ended", { assistantMessageID: input.message, ordinal: 0, text: input.text })
    emit("session.step.ended", { assistantMessageID: input.message, finish: "stop", tokens: { input: 1 }, cost: 0 })
    await settleStream()
    await idle(input.background)
    emit("session.execution.succeeded")
    await settleStream()
  }
  return {
    ctx,
    session,
    options,
    emit,
    emitRaw,
    idle,
    run,
    finish,
    records,
    uncertainty,
    hooks,
    lifetime,
    end,
    lose() {
      live = false
    },
    metrics: () => ({ hookDisposed, streamClosed, ended }),
  }
}

test("actual observed owned title event establishes readiness; wait follows received terminal", async () => {
  const f = fixture(),
    observer = await createOwnedChildObserver(f.ctx, f.options)
  expect(f.records.some((row) => row.kind === "host" && row.event.type === "session.title.updated")).toBe(true)
  await expect(observer.waitForOutcome()).rejects.toThrow("expected")
  observer.expectInput("own")
  const result = observer.waitForOutcome()
  await f.finish("final response")
  expect(await result).toMatchObject({
    status: "completed",
    text: "final response",
    model: { providerID: "actual", id: "observed" },
    consumption: "unconfirmed",
  })
  await observer.dispose()
  expect(f.metrics().hookDisposed).toBe(2)
  expect(f.metrics().ended).toBe(true)
  expect(observer.outcome().status).toBe("uncertain")
  expect(() => observer.expectInput("late")).toThrow()
})

test("missing readiness event fails closed and disposes registration and stream", async () => {
  const f = fixture(false)
  await expect(createOwnedChildObserver(f.ctx, { ...f.options, timeoutMs: 10 })).rejects.toThrow("readiness-timeout")
  expect(f.metrics().hookDisposed).toBe(2)
  expect(f.metrics().ended).toBe(true)
  expect(f.records).toEqual([])
})

test("guard loss makes waiting result uncertain and ends observation", async () => {
  const f = fixture(),
    observer = await createOwnedChildObserver(f.ctx, f.options)
  observer.expectInput("own")
  const waiting = observer.waitForOutcome()
  f.lose()
  f.emit("session.execution.started")
  expect((await waiting).status).toBe("uncertain")
  expect(f.uncertainty.length).toBeGreaterThan(0)
  await observer.dispose()
})

test("stream closure cannot fabricate a result and a caller wait abort leaves observer alive", async () => {
  const f = fixture(),
    observer = await createOwnedChildObserver(f.ctx, f.options)
  observer.expectInput("own")
  const stop = new AbortController()
  const abandoned = observer.waitForOutcome(stop.signal)
  stop.abort(Error("caller cancelled"))
  await expect(abandoned).rejects.toThrow("caller cancelled")
  const waiting = observer.waitForOutcome()
  f.end()
  expect((await waiting).status).toBe("uncertain")
  await observer.dispose()
})

test("late registration after lifetime abort is disposed and never activates observer", async () => {
  const f = fixture()
  let release!: () => void
  const hold = new Promise<void>((yes) => (release = yes))
  const hook = f.session.hook
  f.session.hook = async (...args) => {
    const handle = await hook(...args)
    await hold
    return handle
  }
  const creation = createOwnedChildObserver(f.ctx, f.options)
  f.lifetime.abort()
  release()
  await expect(creation).rejects.toThrow()
  expect(f.metrics().hookDisposed).toBe(1)
  expect(f.records).toEqual([])
})

test("readiness timeout also aborts a pending public title request", async () => {
  const f = fixture(false)
  let aborted = false
  f.session.update = async (_input, { signal }) =>
    new Promise((_yes, no) => {
      const stop = () => {
        aborted = true
        no(signal.reason)
      }
      if (signal.aborted) stop()
      else signal.addEventListener("abort", stop, { once: true })
    })
  await expect(createOwnedChildObserver(f.ctx, { ...f.options, timeoutMs: 10 })).rejects.toThrow("readiness-timeout")
  expect(aborted).toBe(true)
  expect(f.metrics().hookDisposed).toBe(2)
  expect(f.metrics().ended).toBe(true)
})

test("bare Promise session cannot claim title-request cancellation through a truthy config flag", async () => {
  const f = fixture()
  let updateCalled = false
  const bare = {
    hook: f.session.hook,
    async update() {
      updateCalled = true
    },
    joinedCancellation: true,
  }
  await expect(
    createOwnedChildObserver({ ...f.ctx, session: bare as unknown as ObserverHost["session"] }, f.options),
  ).rejects.toThrow("joined session cancellation")
  expect(updateCalled).toBe(false)
  expect(f.records).toEqual([])
  expect(f.hooks.size).toBe(0)
})

test("completion policy rejects unknown runtime values before guard bind or host calls", async () => {
  for (const invalid of ["unknown", null, false, 0, {}]) {
    const f = fixture()
    let effects = 0
    const options = {
      ...f.options,
      completion: invalid as never,
      guard() {
        effects++
      },
      store: {
        bind() {
          effects++
          throw Error("bound")
        },
        close() {},
      },
    }
    await expect(createOwnedChildObserver(f.ctx, options)).rejects.toThrow("completion policy")
    expect(effects).toBe(0)
    expect(f.hooks.size).toBe(0)
    expect(f.records).toEqual([])
  }
})

test("observer captures turn policy before binding and option mutation cannot change waiters", async () => {
  const f = fixture()
  const options: OwnedChildObserverOptions = { ...f.options, completion: "turn" }
  const bind = f.options.store.bind
  f.options.store.bind = (input) => {
    ;(options as { completion: string }).completion = "final-text"
    return bind(input)
  }
  const observer = await createOwnedChildObserver(f.ctx, options)
  observer.expectInput("own")
  const waiting = observer.waitForOutcome()
  await f.finish("")
  expect(await waiting).toMatchObject({ status: "completed", text: "" })
  expect(observer.outcome()).toMatchObject({ status: "completed", text: "" })
  await observer.dispose()
})

test("default observer cannot be switched to turn policy after creation", async () => {
  const f = fixture()
  const options: OwnedChildObserverOptions = { ...f.options }
  const observer = await createOwnedChildObserver(f.ctx, options)
  ;(options as { completion: string }).completion = "turn"
  observer.expectInput("own")
  const waiting = observer.waitForOutcome()
  await f.finish("")
  expect(await waiting).toMatchObject({ status: "error", reason: "empty-assistant-output" })
  await observer.dispose()
})

describe("#given a child turn that ends while the child still owns background work (omo#9069)", () => {
  const shell = (shellID: string) => ({ kind: "shell", sessionID: "child", shellID, command: `run ${shellID}` })

  test("#when the job's notice wakes the child #then only the wake run's outcome settles the turn, once", async () => {
    const f = fixture(),
      observer = await createOwnedChildObserver(f.ctx, f.options)
    observer.expectInput("own")
    const settled: unknown[] = []
    const waiting = observer.waitForOutcome().then((result) => {
      settled.push(result)
      return result
    })

    // when: the turn ends while its own background shell runs
    await f.run({ message: "first", text: "waiting on my test run", inbox: "own", background: [shell("sh_1")] })

    // then: nothing is reported yet
    expect(settled).toEqual([])
    expect(observer.outcome().status).toBe("pending")

    // when: the shell exits, its notice wakes the child and the wake run ends with nothing pending
    f.emitRaw({ type: "shell.exited", data: { id: "sh_1", status: "exited", exit: 0 } })
    await f.run({ message: "second", text: "tests passed", inbox: "notice", background: [] })

    // then: the wake run's outcome is the turn's, delivered exactly once
    expect(await waiting).toMatchObject({ status: "completed", text: "tests passed" })
    expect(settled).toHaveLength(1)
    expect(observer.outcome()).toMatchObject({ status: "completed", text: "tests passed" })
    await observer.dispose()
  })

  test("#when only a descendant owns the job #then the turn settles at once", async () => {
    const f = fixture(),
      observer = await createOwnedChildObserver(f.ctx, f.options)
    observer.expectInput("own")
    const waiting = observer.waitForOutcome()
    await f.run({
      message: "first",
      text: "done",
      inbox: "own",
      background: [{ kind: "shell", sessionID: "grandchild", shellID: "sh_9", command: "run" }],
    })
    expect(await waiting).toMatchObject({ status: "completed", text: "done" })
    await observer.dispose()
  })

  test("#when the wake run fails #then the error waits for a confirmation while an own shell still runs", async () => {
    const f = fixture(),
      confirmation = manualConfirmation(),
      observer = await createOwnedChildObserver(f.ctx, {
        ...f.options,
        settlement: { confirmMs: 1, schedule: confirmation.schedule },
      })
    observer.expectInput("own")
    const settled: unknown[] = []
    const waiting = observer.waitForOutcome().then((result) => {
      settled.push(result)
      return result
    })
    await f.run({ message: "first", text: "waiting", inbox: "own", background: [shell("sh_1"), shell("sh_2")] })
    f.emitRaw({ type: "shell.exited", data: { id: "sh_1", status: "exited" } })
    f.emit("session.execution.started")
    f.emit("session.inbox.delivered", { inboxID: "notice" })
    f.emit("session.step.started", { assistantMessageID: "second", model: { providerID: "actual", id: "observed" } })
    f.emit("session.step.failed", { assistantMessageID: "second", error: { type: "provider.error" } })
    f.emit("session.execution.failed", { error: { type: "provider.error" } })
    await settleStream()

    // when: the confirmation runs while sh_2 still belongs to the child
    await confirmation.fire()

    // then: the error is still held
    expect(settled).toEqual([])
    expect(observer.outcome().status).toBe("pending")

    // when: the last own shell ends and the confirmation runs again
    f.emitRaw({ type: "shell.exited", data: { id: "sh_2", status: "exited" } })
    await settleStream()
    expect(confirmation.armed()).toBe(1)
    await confirmation.fire()

    // then: the held error settles once
    expect(await waiting).toMatchObject({ status: "error", reason: "provider.error" })
    expect(settled).toHaveLength(1)
    await observer.dispose()
  })

  test("#when a run fails with nothing of its own pending #then the error settles at once", async () => {
    const f = fixture(),
      confirmation = manualConfirmation(),
      observer = await createOwnedChildObserver(f.ctx, {
        ...f.options,
        settlement: { confirmMs: 1, schedule: confirmation.schedule },
      })
    observer.expectInput("own")
    const waiting = observer.waitForOutcome()
    f.emit("session.execution.started")
    f.emit("session.inbox.delivered", { inboxID: "own" })

    // when: the run fails while the child owns no background work and no input waits
    f.emit("session.execution.failed", { error: { type: "provider.error" } })

    // then: the error settles without waiting for the confirmation
    expect(await waiting).toMatchObject({ status: "error", reason: "provider.error" })
    expect(confirmation.armed()).toBe(0)
    await observer.dispose()
  })

  test("#when the parent stops the held child #then the turn settles at once as cancelled", async () => {
    const f = fixture(),
      observer = await createOwnedChildObserver(f.ctx, f.options)
    observer.expectInput("own")
    const waiting = observer.waitForOutcome()
    await f.run({ message: "first", text: "waiting", inbox: "own", background: [shell("sh_1")] })
    observer.markStopping()
    expect(await waiting).toMatchObject({ status: "cancelled" })
    expect(observer.outcome().status).toBe("cancelled")
    await observer.dispose()
  })
})

async function sourceFixture(options = {}) {
  const { Effect, Scope, Exit } = await import("effect"),
    scope = Scope.makeUnsafe()
  let hook: ((input: unknown) => EffectModule.Effect<void>) | undefined,
    disposed = 0
  const { acquireEffectToolMetadataSource } = await import("./effect-tool-metadata-source")
  const tool = {
    hook(_name: string, callback: (input: unknown) => EffectModule.Effect<void>) {
      return Effect.gen(function* () {
        hook = callback
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            hook = undefined
            disposed++
          }),
        )
        return { dispose: Effect.void }
      })
    },
  } as unknown as ToolDomain
  const source = await Effect.runPromise(
    Effect.provideService(acquireEffectToolMetadataSource(tool, options), Scope.Scope, scope),
  )
  return {
    source,
    emit: async (extra = {}) => {
      if (hook)
        await Effect.runPromise(
          hook({
            sessionID: "child",
            messageID: "assistant",
            id: "actual_call",
            tool: "final_routed_target",
            status: "completed",
            input: "secret",
            result: "secret",
            ...extra,
          }),
        )
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))),
    disposed: () => disposed,
  }
}
function toolEvents(f: ReturnType<typeof fixture>, message = "assistant", callID = "actual_call", status = "success") {
  f.emit("session.tool.called", { assistantMessageID: message, id: callID })
  f.emit(`session.tool.${status}`, {
    assistantMessageID: message,
    id: callID,
    ...(status === "failed" ? { error: { type: "tool.error" } } : {}),
  })
}

test("safe observation explicitly reports source absence without changing text completion", async () => {
  const f = fixture(),
    observer = await createOwnedChildObserver(f.ctx, f.options)
  const view = observer.observation()
  expect(view.toolMetadata).toMatchObject({
    coverage: "unavailable",
    reasons: ["tool-metadata-source-unavailable"],
    joined: [],
  })
  expect("binding" in view).toBe(false)
  expect("token" in view).toBe(false)
  expect(Object.isFrozen(view.records)).toBe(true)
  observer.expectInput("own")
  await f.finish()
  expect((await observer.waitForOutcome()).status).toBe("completed")
  await observer.dispose()
  expect(observer.observation()).toMatchObject({ records: [], toolMetadata: { coverage: "unavailable" } })
})
test("genuine optional source captures final target and joins only actual session message and call", async () => {
  const f = fixture(),
    s = await sourceFixture(),
    observer = await createOwnedChildObserver(f.ctx, { ...f.options, toolMetadataSource: s.source })
  await s.emit({ sessionID: "foreign" })
  expect(observer.observation().records.filter((r) => r.kind === "tool-metadata")).toEqual([])
  toolEvents(f)
  await s.emit()
  await s.emit()
  const view = observer.observation()
  expect(view.toolMetadata.joined).toEqual([
    {
      sessionID: "child",
      messageID: "assistant",
      callID: "actual_call",
      tool: "final_routed_target",
      status: "completed",
    },
  ])
  expect(view.records.filter((r) => r.kind === "tool-metadata")).toHaveLength(1)
  expect(view.toolMetadata.coverage).toBe("partial")
  expect(JSON.stringify(view)).not.toContain("secret")
  expect(Object.isFrozen(view.toolMetadata.joined[0])).toBe(true)
  expect("binding" in view).toBe(false)
  await observer.dispose()
  await s.emit({ id: "late" })
  expect(observer.observation().records).toEqual([])
  await s.close()
  expect(s.disposed()).toBe(1)
})
test("message or call mismatch never joins by name or arrival time", async () => {
  for (const extra of [{ messageID: "other_message" }, { id: "other_call" }]) {
    const f = fixture(),
      s = await sourceFixture(),
      observer = await createOwnedChildObserver(f.ctx, { ...f.options, toolMetadataSource: s.source })
    toolEvents(f)
    await s.emit(extra)
    const view = observer.observation()
    expect(view.toolMetadata.joined).toEqual([])
    expect(view.toolMetadata.reasons).toContain("missing-tool-metadata")
    expect(view.toolMetadata.reasons).toContain("unmatched-tool-metadata")
    await observer.dispose()
    await s.close()
  }
})
test("conflicting duplicate metadata and status mismatch cannot claim transcript coverage", async () => {
  for (const extra of [{ tool: "other_final" }, { messageID: "other_message" }, { status: "error" }]) {
    const f = fixture(),
      s = await sourceFixture(),
      observer = await createOwnedChildObserver(f.ctx, { ...f.options, toolMetadataSource: s.source })
    toolEvents(f)
    await s.emit()
    await s.emit(extra)
    expect(observer.observation().toolMetadata).toMatchObject({
      coverage: "uncertain",
      reasons: ["conflicting-tool-metadata"],
    })
    observer.expectInput("own")
    await f.finish()
    expect((await observer.waitForOutcome()).status).toBe("uncertain") // unmatched host tool step keeps the existing outcome fence
    await observer.dispose()
    await s.close()
  }
  const f = fixture(),
    s = await sourceFixture(),
    observer = await createOwnedChildObserver(f.ctx, { ...f.options, toolMetadataSource: s.source })
  toolEvents(f)
  await s.emit({ status: "error" })
  expect(observer.observation().toolMetadata.reasons).toContain("conflicting-tool-status")
  expect(observer.observation().toolMetadata.joined).toEqual([])
  await observer.dispose()
  await s.close()
})
test("source closed or malformed is explicit coverage gap while a complete text result stays valid", async () => {
  for (const malformed of [false, true]) {
    const f = fixture(),
      s = await sourceFixture(),
      observer = await createOwnedChildObserver(f.ctx, { ...f.options, toolMetadataSource: s.source })
    if (malformed) await s.emit({ messageID: "bad\nidentity" })
    else await s.close()
    expect(observer.observation().toolMetadata.coverage).toBe("uncertain")
    observer.expectInput("own")
    await f.finish()
    expect((await observer.waitForOutcome()).status).toBe("completed")
    await observer.dispose()
    await s.close()
  }
})
test("forged source refuses before binding and stale guard withholds all safe rows", async () => {
  const f = fixture()
  let binds = 0
  const original = f.options.store.bind
  f.options.store.bind = (input) => {
    binds++
    return original(input)
  }
  await expect(createOwnedChildObserver(f.ctx, { ...f.options, toolMetadataSource: {} as never })).rejects.toThrow(
    "source",
  )
  expect(binds).toBe(0)
  const s = await sourceFixture(),
    observer = await createOwnedChildObserver(f.ctx, { ...f.options, toolMetadataSource: s.source })
  await s.emit()
  f.lose()
  expect(observer.observation().records).toEqual([])
  expect(observer.observation().uncertainty.length).toBeGreaterThan(0)
  await observer.dispose()
  await s.close()
})
test("lease cancellation joins owned metadata pump and prevents late deliveries", async () => {
  const f = fixture(),
    s = await sourceFixture(),
    observer = await createOwnedChildObserver(f.ctx, { ...f.options, toolMetadataSource: s.source })
  f.lifetime.abort()
  await observer.dispose()
  await s.emit()
  expect(f.records.filter((r) => r.kind === "tool-metadata")).toEqual([])
  expect(observer.observation().records).toEqual([])
  await s.close()
})

test("metadata conflict is independent of a valid completed text turn", async () => {
  const f = fixture(),
    s = await sourceFixture(),
    observer = await createOwnedChildObserver(f.ctx, { ...f.options, toolMetadataSource: s.source })
  await s.emit()
  await s.emit({ tool: "conflict" })
  observer.expectInput("own")
  await f.finish()
  expect((await observer.waitForOutcome()).status).toBe("completed")
  expect(observer.observation().toolMetadata.coverage).toBe("uncertain")
  await observer.dispose()
  await s.close()
})
test("synchronous metadata drain cannot outrun disposed or replaced custody", async () => {
  const f = fixture(),
    s = await sourceFixture()
  const observer = await createOwnedChildObserver(f.ctx, { ...f.options, toolMetadataSource: s.source })
  await s.emit()
  await observer.dispose()
  await s.close()
  expect(observer.observation().records).toEqual([])
  const replacement = fixture(),
    nextSource = await sourceFixture(),
    next = await createOwnedChildObserver(replacement.ctx, {
      ...replacement.options,
      key: "replacement",
      toolMetadataSource: nextSource.source,
    })
  expect(next.observation().records.filter((r) => r.kind === "tool-metadata")).toEqual([])
  await next.dispose()
  await nextSource.close()
})

async function joinSequence(
  sequence: readonly ("called" | "success" | "failed")[],
  status: "completed" | "error" = "completed",
) {
  const f = fixture(),
    s = await sourceFixture(),
    observer = await createOwnedChildObserver(f.ctx, { ...f.options, toolMetadataSource: s.source })
  for (const type of sequence)
    f.emit(`session.tool.${type}`, {
      assistantMessageID: "assistant",
      id: "actual_call",
      ...(type === "failed" ? { error: { type: "tool.error" } } : {}),
    })
  await s.emit({ status })
  return {
    f,
    s,
    observer,
    async close() {
      await observer.dispose()
      await s.close()
    },
  }
}
test("safe tool joins refuse contradictory distinct host terminals rather than overwriting them", async () => {
  const f = await joinSequence(["called", "success", "failed"], "error")
  try {
    const view = f.observer.observation().toolMetadata
    expect(view).toMatchObject({ coverage: "uncertain", joined: [] })
    expect(view.reasons).toContain("ambiguous-tool-event-sequence")
    expect(f.observer.outcome().status).toBe("uncertain")
  } finally {
    await f.close()
  }
})
test("safe tool joins require one called before one terminal and refuse distinct-event duplicates", async () => {
  for (const sequence of [
    ["success", "called"],
    ["called", "called", "success"],
    ["called", "success", "success"],
    ["called", "failed", "failed"],
    ["called", "success", "called"],
  ] as const) {
    const f = await joinSequence(sequence, sequence.includes("failed" as never) ? "error" : "completed")
    try {
      expect(f.observer.observation().toolMetadata.coverage).toBe("uncertain")
      expect(f.observer.observation().toolMetadata.joined).toEqual([])
      expect(f.observer.observation().toolMetadata.reasons).toContain("ambiguous-tool-event-sequence")
    } finally {
      await f.close()
    }
  }
})
test("safe tool joins deduplicate exact same event ID but refuse conflicting reuse", async () => {
  for (const conflict of [false, true]) {
    const f = await joinSequence(["called", "success"])
    try {
      const terminal = defined(
        f.f.records.find((row) => row.kind === "host" && row.event.type === "session.tool.success"),
      ) as Extract<ObservationRecord, { kind: "host" }>
      f.f.records.push(
        conflict
          ? {
              ...structuredClone(terminal),
              event: {
                ...structuredClone(terminal.event),
                type: "session.tool.failed",
                data: { ...terminal.event.data, errorType: "tool.error" },
              },
            }
          : structuredClone(terminal),
      )
      const view = f.observer.observation().toolMetadata
      if (conflict) {
        expect(view.coverage).toBe("uncertain")
        expect(view.joined).toEqual([])
        expect(view.reasons).toContain("conflicting-tool-event-id")
      } else {
        expect(view.coverage).toBe("partial")
        expect(view.joined).toHaveLength(1)
        expect(view.reasons).toEqual([])
      }
    } finally {
      await f.close()
    }
  }
})
test("safe tool joins refuse same call identity reused by another assistant", async () => {
  const f = await joinSequence(["called", "success"])
  try {
    f.f.emit("session.tool.called", { assistantMessageID: "other_assistant", id: "actual_call" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const view = f.observer.observation().toolMetadata
    expect(view.coverage).toBe("uncertain")
    expect(view.joined).toEqual([])
    expect(view.reasons).toContain("conflicting-tool-event-identity")
  } finally {
    await f.close()
  }
})

test("safe tool joins withhold rows for missing or foreign host tool identity", async () => {
  for (const bad of [{ assistantMessageID: undefined }, { sessionID: "foreign" }]) {
    const f = await joinSequence(["called", "success"])
    try {
      const original = defined(
        f.f.records.find((row) => row.kind === "host" && row.event.type === "session.tool.called"),
      ) as Extract<ObservationRecord, { kind: "host" }>
      const { assistantMessageID, ...data } = original.event.data
      f.f.records.push({
        kind: "host",
        id: "extra_tool_identity",
        event: {
          ...structuredClone(original.event),
          id: "extra_tool_identity",
          ...(bad.sessionID ? { sessionID: bad.sessionID, durable: undefined } : {}),
          data: bad.sessionID ? original.event.data : data,
        },
      })
      const view = f.observer.observation().toolMetadata
      expect(view.coverage).toBe("uncertain")
      expect(view.joined).toEqual([])
      expect(view.reasons).toContain(bad.sessionID ? "foreign-tool-event-identity" : "missing-tool-event-identity")
    } finally {
      await f.close()
    }
  }
})
