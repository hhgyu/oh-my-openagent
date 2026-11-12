import { describe, expect, test } from "bun:test"

import type { SendOutcome } from "../../steering"
import { bounded } from "../../lifecycle/__fixtures__/live-parent-clock"
import { runTaskSend } from "./send"
import type { LateSendDelivery } from "./send"
import type { SendManager, SendToolResult } from "./types"

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected value to be present")
  return value
}

function busyManager(): { manager: SendManager; settle: (outcome: SendOutcome) => void; calls: () => number } {
  const pending = Promise.withResolvers<SendOutcome>()
  let calls = 0
  return {
    manager: {
      sendToTask: () => {
        calls += 1
        return pending.promise
      },
      list: () => [],
    },
    settle: pending.resolve,
    calls: () => calls,
  }
}

type Late = { readonly result: SendToolResult; readonly delivery: LateSendDelivery }

function lateOutcomes(): {
  deliver: (result: SendToolResult, delivery: LateSendDelivery) => void
  next: Promise<Late>
} {
  const arrived = Promise.withResolvers<Late>()
  return { deliver: (result, delivery) => arrived.resolve({ result, delivery }), next: arrived.promise }
}

describe("task_send against a busy task host (#10042)", () => {
  test("#given a send the host does not answer #when task_send runs #then it returns delivering and the outcome arrives later", async () => {
    // given
    const busy = busyManager()
    const late = lateOutcomes()

    // when
    const result = await bounded(
      runTaskSend(busy.manager, { to: "st_00000001", message: "hi" }, "parent-1", undefined, {
        deliverLateOutcome: late.deliver,
      }),
    )
    busy.settle({ kind: "revived", task_id: "st_00000001", run_epoch: 2 })

    // then
    expect(result.details).toMatchObject({ kind: "delivering", to: "st_00000001", reason: "host_slow" })
    const arrived = await bounded(late.next)
    expect(arrived.result.details).toEqual({ kind: "revived", task_id: "st_00000001", run_epoch: 2 })
    expect(arrived.delivery).toEqual({ cause: "host_slow", callerSessionId: "parent-1" })
  })

  test("#given a send still in flight #when the parent turn aborts #then task_send returns at once and the outcome still arrives", async () => {
    // given
    const busy = busyManager()
    const late = lateOutcomes()
    const controller = new AbortController()
    const running = runTaskSend(busy.manager, { to: "st_00000001", message: "hi" }, "parent-1", undefined, {
      signal: controller.signal,
      deliverLateOutcome: late.deliver,
    })

    // when
    controller.abort(new Error("parent aborted"))
    const result = await bounded(running)
    busy.settle({
      kind: "not_continuable",
      task_id: "st_00000001",
      reason: "session_unavailable",
      suggestion: "read it",
    })

    // then
    expect(result.details).toMatchObject({ kind: "delivering", reason: "aborted" })
    const arrived = await bounded(late.next)
    expect(arrived.result.details).toMatchObject({ kind: "not_continuable", reason: "session_unavailable" })
    expect(arrived.delivery.cause).toBe("aborted")
  })

  test("#given a parent turn already aborted #when task_send runs #then nothing is sent", async () => {
    const busy = busyManager()
    const controller = new AbortController()
    controller.abort(new Error("parent aborted"))

    const result = await bounded(
      runTaskSend(busy.manager, { to: "st_00000001", message: "hi" }, "parent-1", undefined, {
        signal: controller.signal,
      }),
    )

    expect(busy.calls()).toBe(0)
    expect(result.details).toMatchObject({ kind: "aborted" })
  })

  test("#given a caller with no channel for a late outcome (Desktop RPC, team member) #when its turn aborts mid-send #then task_send still returns at once", async () => {
    const busy = busyManager()
    const controller = new AbortController()
    const running = runTaskSend(busy.manager, { to: "st_00000001", message: "hi" }, "parent-1", undefined, {
      signal: controller.signal,
    })

    controller.abort(new Error("parent aborted"))
    const result = await bounded(running)
    busy.settle({ kind: "revived", task_id: "st_00000001", run_epoch: 2 })

    expect(result.details).toMatchObject({ kind: "delivering", reason: "aborted" })
    expect(busy.calls()).toBe(1)
  })
})


test("a host retains the canonical mapped send and returned late delivery work", async () => {
  const busy = busyManager()
  const controller = new AbortController()
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const work: { phase: "sending" | "late"; promise: Promise<unknown> }[] = []
  let deliveryFinished = false
  const options = {
    signal: controller.signal,
    retainWork(promise: Promise<unknown>, phase: "sending" | "late") { work.push({ promise, phase }); void promise.catch(() => {}) },
    async deliverLateOutcome() { entered.resolve(); await gate.promise; deliveryFinished = true },
  }
  const reporting = runTaskSend(busy.manager, { to: "st_00000001", message: "hi" }, "parent-1", undefined, options)
  controller.abort(Error("reporting stopped"))
  try {
    expect((await bounded(reporting)).details.kind).toBe("delivering")
    expect(work.map(row => row.phase)).toEqual(["sending", "late"])
    busy.settle({ kind: "revived", task_id: "st_00000001", run_epoch: 2 })
    await bounded(entered.promise)
    expect(await bounded(present(work[0]).promise)).toMatchObject({ content: expect.any(Array), details: { kind: "revived", run_epoch: 2 } })
    let lateJoined = false
    void present(work[1]).promise.then(() => { lateJoined = true })
    await Promise.resolve(); await Promise.resolve()
    expect(lateJoined).toBe(false)
    expect(deliveryFinished).toBe(false)
    gate.resolve()
    await bounded(present(work[1]).promise)
    expect(deliveryFinished).toBe(true)
    expect(busy.calls()).toBe(1)
  } finally {
    busy.settle({ kind: "revived", task_id: "st_00000001", run_epoch: 2 })
    gate.resolve()
    await reporting
  }
})


test("retained late work exposes an asynchronous delivery rejection without resending", async () => {
  const busy = busyManager()
  const controller = new AbortController()
  const work: { phase: string; promise: Promise<unknown> }[] = []
  const failure = Error("late delivery failed")
  const reporting = runTaskSend(busy.manager, { to: "st_00000001", message: "hi" }, "parent-1", undefined, {
    signal: controller.signal,
    retainWork(promise, phase) { work.push({ phase, promise }); void promise.catch(() => {}) },
    async deliverLateOutcome() { throw failure },
  })
  controller.abort(Error("stop reporting"))
  expect((await bounded(reporting)).details.kind).toBe("delivering")
  busy.settle({ kind: "revived", task_id: "st_00000001", run_epoch: 2 })
  expect(await bounded(present(work.find(row => row.phase === "sending")).promise)).toMatchObject({ details: { kind: "revived" } })
  await expect(bounded(present(work.find(row => row.phase === "late")).promise)).rejects.toBe(failure)
  expect(busy.calls()).toBe(1)
})

test("an already aborted caller creates no retained Native work", async () => {
  const busy = busyManager()
  const controller = new AbortController()
  controller.abort(Error("already stopped"))
  const work: Promise<unknown>[] = []
  const result = await runTaskSend(busy.manager, { to: "st_00000001", message: "hi" }, "parent-1", undefined, {
    signal: controller.signal,
    retainWork(promise) { work.push(promise) },
  })
  expect(result.details.kind).toBe("aborted")
  expect(busy.calls()).toBe(0)
  expect(work).toHaveLength(0)
})
