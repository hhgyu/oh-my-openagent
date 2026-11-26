import { describe, expect, test } from "bun:test"

import { createCoalescingQueue, type CoalescedFlush } from "./append-queue"

class Expired extends Error {}

function fakeClock() {
  let time = 0
  const timers: Array<{ at: number; run: () => void; live: boolean }> = []
  return {
    now: () => time,
    schedule(delayMs: number, run: () => void) {
      const timer = { at: time + delayMs, run, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
    advanceTo(next: number) {
      time = next
      for (const timer of timers.filter((candidate) => candidate.live && candidate.at <= time)) {
        timer.live = false
        timer.run()
      }
    },
  }
}

function gate() {
  let open: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function blockedFlush(blocked: Promise<void>) {
  const written: string[][] = []
  const waits: number[] = []
  const flush: CoalescedFlush<string, string> = async (_key, take, waitTimeoutMs) => {
    waits.push(waitTimeoutMs)
    await blocked
    const batch = [...take()]
    written.push(batch)
    return batch.map((input) => `ok:${input}`)
  }
  return { flush, written, waits }
}

function outcome<T>(promise: Promise<T>) {
  const state: { value?: T; error?: unknown; done: boolean } = { done: false }
  promise.then(
    (value) => Object.assign(state, { value, done: true }),
    (error: unknown) => Object.assign(state, { error, done: true }),
  )
  return state
}

describe("coalescing append queue", () => {
  test("#given a flush stalled before taking its batch #when queued callers pass their deadlines #then they reject then and are never written", async () => {
    // given
    const clock = fakeClock()
    const lock = gate()
    const { flush, written, waits } = blockedFlush(lock.opened)
    const queue = createCoalescingQueue(flush, {
      deadlineMs: 100,
      maxBatch: 10,
      expired: () => new Expired("expired"),
      now: clock.now,
      schedule: clock.schedule,
    })
    const first = outcome(queue.submit("k", "a"))
    clock.advanceTo(10)
    const second = outcome(queue.submit("k", "b"))
    clock.advanceTo(105)
    const late = outcome(queue.submit("k", "c"))

    // when
    clock.advanceTo(110)
    await settle()

    // then
    expect(first.error).toBeInstanceOf(Expired)
    expect(second.error).toBeInstanceOf(Expired)
    expect(late.done).toBe(false)
    expect(waits).toEqual([100])

    // when
    lock.open()
    await settle()

    // then
    expect(written).toEqual([["c"]])
    expect(late.value).toBe("ok:c")
  })

  test("#given more callers than one batch holds #when the flush runs #then each batch is capped and every caller is served in order", async () => {
    // given
    const clock = fakeClock()
    const lock = gate()
    const { flush, written } = blockedFlush(lock.opened)
    const queue = createCoalescingQueue(flush, {
      deadlineMs: 100,
      maxBatch: 2,
      expired: () => new Expired("expired"),
      now: clock.now,
      schedule: clock.schedule,
    })
    const results = ["1", "2", "3", "4", "5"].map((input) => queue.submit("k", input))

    // when
    lock.open()

    // then
    expect(await Promise.all(results)).toEqual(["ok:1", "ok:2", "ok:3", "ok:4", "ok:5"])
    expect(written).toEqual([["1", "2"], ["3", "4"], ["5"]])
  })

  test("#given a flush that fails before taking #when it throws #then callers its wait covered get its error and a later caller gets its own flush", async () => {
    // given
    const clock = fakeClock()
    const lock = gate()
    const failure = new Error("lock wait ran out")
    let calls = 0
    const written: string[][] = []
    const queue = createCoalescingQueue<string, string>(
      async (_key, take) => {
        calls++
        if (calls === 1) {
          await lock.opened
          throw failure
        }
        const batch = [...take()]
        written.push(batch)
        return batch
      },
      {
        deadlineMs: 100,
        maxBatch: 10,
        expired: () => new Expired("expired"),
        now: clock.now,
        schedule: clock.schedule,
      },
    )
    const covered = outcome(queue.submit("k", "a"))
    clock.advanceTo(50)
    const later = outcome(queue.submit("k", "b"))

    // when
    lock.open()
    await settle()

    // then
    expect(covered.error).toBe(failure)
    expect(later.value).toBe("b")
    expect(written).toEqual([["b"]])
  })

  test("#given a flush that fails after taking its batch #when it throws #then every taken caller rejects with that error", async () => {
    // given
    const failure = new Error("append failed")
    const queue = createCoalescingQueue<string, string>(
      async (_key, take) => {
        take()
        throw failure
      },
      { deadlineMs: 100, maxBatch: 10, expired: () => new Expired("expired") },
    )

    // when
    const results = await Promise.allSettled([queue.submit("k", "a"), queue.submit("k", "b")])

    // then
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ])
  })
})
