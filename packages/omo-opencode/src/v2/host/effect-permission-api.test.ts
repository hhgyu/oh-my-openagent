import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Scope, Schema } from "effect"
import { AssertInput } from "@opencode/plugin/permission"
import type { PermissionDomain } from "@opencode/plugin/effect/permission"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { acquireEffectPermissionApi, hasJoinedPermissionCancellation, PermissionRequestInterruptedError, PermissionTransportClosedError } from "./effect-permission-api"

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const input = Schema.decodeUnknownSync(AssertInput)({ sessionID: "ses_unit_parent", agent: "unit-agent", action: "subagent", resources: ["actual-unit-build"],
  source: { type: "tool" as const, messageID: "unit-message", id: "unit-call" }, metadata: { unit: true }, save: ["actual-unit-build"] })

/** Controlled UNIT domain, genuine Effect scoped fibers and published codecs.
 * Unknown failure values intentionally exercise the adapter's boundary; no
 * actual SDK host, permission evaluator or approval request is claimed. */
async function fixture(operation: (value: Parameters<PermissionDomain["assert"]>[0]) => Effect.Effect<void, unknown, Scope.Scope>) {
  const scope = Scope.makeUnsafe(), values: unknown[] = [], argumentCounts: number[] = []
  const domain = { assert(...args: Parameters<PermissionDomain["assert"]>) { values.push(args[0]); argumentCounts.push(args.length); return Effect.scoped(operation(args[0])) } } as Pick<PermissionDomain, "assert">
  const api = await Effect.runPromise(Effect.provideService(acquireEffectPermissionApi(domain), Scope.Scope, scope))
  return { api, values, argumentCounts, close: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))) }
}

test("published AssertInput validates and forwards actual source/agent/resources, no invented SDK options", async () => {
  const f = await fixture(() => Effect.void)
  expect(hasJoinedPermissionCancellation(f.api)).toBe(true)
  expect(hasJoinedPermissionCancellation({ ...f.api })).toBe(false)
  expect(hasJoinedPermissionCancellation(null)).toBe(false)
  await f.api.assert(input, { signal: new AbortController().signal })
  expect(f.values).toEqual([input]); expect(f.argumentCounts).toEqual([1])
  await expect(f.api.assert({ ...input, sessionID: 42 } as never)).rejects.toThrow()
  expect(f.values).toHaveLength(1)
  await f.close()
})

test("actual SDK Tool.Error denial preserves exact class, metadata and object identity", async () => {
  const error = new ToolError({ message: "denied exact resource", metadata: { resource: "actual-unit-build" } })
  const f = await fixture(() => Effect.fail(error))
  await expect(f.api.assert(input)).rejects.toBe(error)
  await f.close()
})

for (const [index, error] of [undefined, null, false, 0, "", Error("actual defect")].entries()) {
  test(`typed falsy/defect identity ${index} never becomes FiberFailure or a truthy fallback`, async () => {
    for (const operation of [() => Effect.fail(error), () => Effect.die(error)]) {
      const f = await fixture(operation)
      await expect(f.api.assert(input)).rejects.toBe(error)
      await f.close()
    }
  })
}

test("caller abort returns its exact reason only AFTER original Effect finalizer finishes", async () => {
  const entered = deferred<void>(), cleaning = deferred<void>(), finalizer = deferred<void>(), order: string[] = []
  const f = await fixture(() => Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.promise(async () => { order.push("cleanup:start"); cleaning.resolve(); await finalizer.promise; order.push("cleanup:end") }))
    entered.resolve(); yield* Effect.never
  }))
  const caller = new AbortController(), reason = { actualCallerAbort: true }
  let settled = false
  const request = f.api.assert(input, { signal: caller.signal }).finally(() => { settled = true; order.push("settled") })
  await entered.promise; caller.abort(reason); await cleaning.promise; await tick()
  expect(settled).toBe(false); expect(order).toEqual(["cleanup:start"])
  finalizer.resolve(); await expect(request).rejects.toBe(reason)
  expect(order).toEqual(["cleanup:start", "cleanup:end", "settled"])
  await f.close()
})

for (const [index, failure] of [undefined, null, false, 0, Error("different finalizer")].entries()) {
  test(`abort cannot mask different original finalizer failure ${index}`, async () => {
    const entered = deferred<void>(), finalizer = deferred<void>(), cleaning = deferred<void>()
    const f = await fixture(() => Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.promise(async () => { cleaning.resolve(); await finalizer.promise }).pipe(Effect.andThen(Effect.die(failure))))
      entered.resolve(); yield* Effect.never
    }))
    const caller = new AbortController(), request = f.api.assert(input, { signal: caller.signal })
    await entered.promise; caller.abort(Error("ordinary cancellation")); await cleaning.promise; finalizer.resolve()
    await expect(request).rejects.toBe(failure); await f.close()
  })
}

test("multiple distinct joined failures retain originals; cancellation and duplicate reflections omitted", async () => {
  const first = { first: true }, second = new ToolError({ message: "second" }), caller = new AbortController()
  const entered = deferred<void>(), finish = deferred<void>()
  const f = await fixture(() => Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.promise(() => finish.promise).pipe(Effect.andThen(Effect.failCause(Cause.combine(Cause.die(first), Cause.combine(Cause.die(second), Cause.die(first)))))))
    entered.resolve(); yield* Effect.never
  }))
  const request = f.api.assert(input, { signal: caller.signal })
  await entered.promise; caller.abort(Error("cancel")); finish.resolve()
  let caught: unknown; try { await request } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(AggregateError)
  const aggregate = caught as AggregateError
  expect(aggregate.errors).toHaveLength(2); expect(aggregate.errors).toContain(first); expect(aggregate.errors).toContain(second)
  expect(aggregate.errors).not.toContain(caller.signal.reason); expect(aggregate.cause).toBeDefined()
  await f.close()
})

test("host interruption without caller signal is explicit interruption, never model-facing success", async () => {
  const f = await fixture(() => Effect.interrupt)
  await expect(f.api.assert(input)).rejects.toBeInstanceOf(PermissionRequestInterruptedError)
  await f.close()
})

test("close owns queued request before first async work and prevents any later domain call", async () => {
  const f = await fixture(() => Effect.void)
  const queued = f.api.assert(input), close = f.api.close()
  await expect(queued).rejects.toBeInstanceOf(PermissionTransportClosedError); await close
  expect(f.values).toHaveLength(0)
  await expect(f.api.assert(input)).rejects.toBeInstanceOf(PermissionTransportClosedError)
  await f.api.close(); await f.close()
})

test("scope close interrupts and joins original request finalizer before scope completes", async () => {
  const entered = deferred<void>(), cleaning = deferred<void>(), finalizer = deferred<void>()
  const f = await fixture(() => Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.promise(async () => { cleaning.resolve(); await finalizer.promise }))
    entered.resolve(); yield* Effect.never
  }))
  const request = f.api.assert(input); await entered.promise
  let ended = false; const close = f.close().then(() => { ended = true })
  await cleaning.promise; await tick(); expect(ended).toBe(false)
  finalizer.resolve(); await expect(request).rejects.toBeInstanceOf(PermissionTransportClosedError); await close
  expect(ended).toBe(true)
})

test("one caller abort does not interrupt a sibling request on the same owner", async () => {
  const entered = deferred<void>(), pending: string[] = []
  const f = await fixture(value => value.resources[0] === "cancel" ? Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => { pending.splice(pending.indexOf("cancel"), 1) }))
    pending.push("cancel"); entered.resolve(); yield* Effect.never
  }) : Effect.sync(() => { pending.push("sibling") }))
  const caller = new AbortController(), first = f.api.assert({ ...input, resources: ["cancel"] }, { signal: caller.signal })
  await entered.promise; caller.abort(false)
  await expect(first).rejects.toBe(false)
  await f.api.assert({ ...input, resources: ["sibling"] })
  expect(pending).toEqual(["sibling"]); await f.close()
})

test("already-aborted falsy caller reason refuses before the domain starts", async () => {
  const f = await fixture(() => Effect.void), caller = new AbortController(); caller.abort(0)
  await expect(f.api.assert(input, { signal: caller.signal })).rejects.toBe(0)
  expect(f.values).toHaveLength(0); await f.close()
})

test("uninterruptible host success after abort remains canceled and original work is joined", async () => {
  const entered = deferred<void>(), finish = deferred<void>()
  const f = await fixture(() => Effect.uninterruptible(Effect.promise(async () => { entered.resolve(); await finish.promise })))
  const caller = new AbortController(); let settled = false
  const request = f.api.assert(input, { signal: caller.signal }).finally(() => { settled = true })
  await entered.promise; caller.abort(false); await tick(); expect(settled).toBe(false)
  finish.resolve(); await expect(request).rejects.toBe(false); await f.close()
})

test("reentrant close observes the original request already owned before domain callback", async () => {
  const entered = deferred<void>(); let close: Promise<void> | undefined
  const f = await fixture(() => Effect.sync(() => { close = f.api.close(); entered.resolve() }).pipe(Effect.andThen(Effect.never)))
  const request = f.api.assert(input); await entered.promise
  await expect(request).rejects.toBeInstanceOf(PermissionTransportClosedError)
  await close; await f.close()
})
