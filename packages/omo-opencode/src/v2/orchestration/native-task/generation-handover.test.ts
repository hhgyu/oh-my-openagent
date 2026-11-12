import { describe, expect, test } from "bun:test"
import { enterNativeGeneration, PREDECESSOR_WAIT_MS, PredecessorParkTimeout } from "./generation-handover"

const directory = () => `unit-handover-${crypto.randomUUID()}`
const settledWithin = async (work: Promise<unknown>, ms = 20) => Promise.race([work.then(() => true, () => true), Bun.sleep(ms).then(() => false)])

describe("#given two plugin generations of one project directory in this process", () => {
  test("#when the older one is closing #then the newer one waits for that close, even a failed one, and the older one never waits for the newer", async () => {
    // given
    const key = directory(), older = enterNativeGeneration(key), newer = enterNativeGeneration(key)
    const olderClose = Promise.withResolvers<undefined>(), newerClose = Promise.withResolvers<undefined>()
    const olderRetired = older.retire(() => olderClose.promise)
    const newerRetired = newer.retire(() => newerClose.promise)

    // when
    const newerWaits = newer.predecessorsSettled()
    const olderWaits = older.predecessorsSettled()

    // then
    expect(await settledWithin(olderWaits)).toBe(true)
    expect(await settledWithin(newerWaits)).toBe(false)
    olderClose.reject(Error("park failed"))
    await expect(olderRetired).rejects.toThrow("park failed")
    expect(await settledWithin(newerWaits)).toBe(true)
    newerClose.resolve(undefined)
    await newerRetired
  })

  test("#when the waiting call is aborted #then its wait rejects while the older close keeps running, and another directory never waits", async () => {
    // given
    const key = directory(), older = enterNativeGeneration(key), newer = enterNativeGeneration(key), foreign = enterNativeGeneration(directory())
    const olderClose = Promise.withResolvers<undefined>()
    const olderRetired = older.retire(() => olderClose.promise)
    const caller = new AbortController()

    // when
    const waiting = newer.predecessorsSettled(caller.signal)
    caller.abort(Error("caller gone"))

    // then
    await expect(waiting).rejects.toThrow("caller gone")
    expect(await settledWithin(foreign.predecessorsSettled())).toBe(true)
    olderClose.resolve(undefined)
    await olderRetired
    expect(await settledWithin(newer.predecessorsSettled())).toBe(true)
  })

  test("#when the older close never settles #then the newer call fails once the bound elapses instead of waiting forever", async () => {
    // given
    const key = directory(), older = enterNativeGeneration(key), newer = enterNativeGeneration(key)
    const olderClose = Promise.withResolvers<undefined>()
    const olderRetired = older.retire(() => olderClose.promise)

    // when
    const started = Date.now()
    const refused = await newer.predecessorsSettled(undefined, 40).then(() => undefined, (error: unknown) => error)

    // then
    expect(refused).toBeInstanceOf(PredecessorParkTimeout)
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
    expect(PREDECESSOR_WAIT_MS).toBe(30_000)
    olderClose.resolve(undefined)
    await olderRetired
    expect(await settledWithin(newer.predecessorsSettled(undefined, 40))).toBe(true)
  })
})
